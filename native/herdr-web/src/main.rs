mod budget;
mod input;
mod output;

use budget::Bytes;
use crossbeam_channel::{Receiver, Sender, bounded, select};
use herdr_client::{
    ClientEvent, ClientHandle, ConnectOptions, ConnectTarget, connect_with_connector,
};
use herdr_protocol::{ClientClipboardImageTarget, ClientShellSnapshot};
use input::{ImageTarget, Input};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, BufReader, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

const INPUT_QUEUE: usize = 16;
const OUTPUT_QUEUE: usize = 2;
const MAX_REQUESTS: usize = 64;
const OUTPUT_WAIT: Duration = Duration::from_millis(100);

struct Args {
    socket: PathBuf,
    options: ConnectOptions,
}
impl Args {
    fn parse() -> Result<Self, String> {
        let mut socket = None;
        let (mut cols, mut rows, mut cell_width, mut cell_height) = (80, 24, 0, 0);
        let mut args = std::env::args().skip(1);
        let mut seen = std::collections::HashSet::new();
        while let Some(arg) = args.next() {
            if !seen.insert(arg.clone()) {
                return Err("duplicate argument".into());
            }
            let value = args.next().ok_or("expected a flag value")?;
            match arg.as_str() {
                "--socket" => socket = Some(PathBuf::from(value)),
                "--cols" => cols = value.parse().map_err(|_| "invalid columns")?,
                "--rows" => rows = value.parse().map_err(|_| "invalid rows")?,
                "--cell-width" => cell_width = value.parse().map_err(|_| "invalid cell width")?,
                "--cell-height" => {
                    cell_height = value.parse().map_err(|_| "invalid cell height")?
                }
                _ => return Err("unknown argument".into()),
            }
        }
        let socket = socket.ok_or("--socket is required")?;
        if !socket.is_absolute()
            || socket
                .file_name()
                .is_none_or(|name| name != "herdr-client.sock")
        {
            return Err(
                "--socket must be an absolute server-resolved herdr-client.sock path".into(),
            );
        }
        Ok(Self {
            socket,
            options: input::geometry(cols, rows, cell_width, cell_height)?,
        })
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--help") {
        println!(
            "herdr-web --socket /absolute/herdr-client.sock [--cols 80] [--rows 24] [--cell-width 0] [--cell-height 0]\nBounded native Herdr JSONL adapter. stdin EOF detaches. No discovery, daemon startup, or reconnect."
        );
        return;
    }
    let args = match Args::parse() {
        Ok(args) => args,
        Err(reason) => {
            eprintln!("herdr-web: {reason}");
            std::process::exit(2);
        }
    };
    if let Err(reason) = run(args) {
        // Do not log event payloads, user input, socket paths, or private content.
        eprintln!("herdr-web: {reason}");
        std::process::exit(1);
    }
}

fn stdin_worker() -> (Receiver<Bytes>, Receiver<String>) {
    let (tx, rx) = bounded(INPUT_QUEUE);
    let budget = Arc::new(AtomicUsize::new(0));
    let (end_tx, end_rx) = bounded(1);
    thread::spawn(move || {
        let mut stdin = BufReader::new(io::stdin());
        let reason = loop {
            match input::read_line(&mut stdin) {
                Ok(Some(line)) => {
                    let Some(line) = Bytes::claim(line, &budget) else {
                        break "stdin byte queue overflow";
                    };
                    if tx.try_send(line).is_err() {
                        break "stdin queue overflow";
                    }
                }
                Ok(None) => break "stdin EOF",
                Err(_) => break "stdin read or line limit failure",
            }
        };
        // Separate channel: EOF must not wait behind a full command queue.
        let _ = end_tx.send(reason.to_owned());
    });
    (rx, end_rx)
}

struct Out {
    tx: Sender<Bytes>,
    budget: Arc<AtomicUsize>,
}
fn stdout_worker() -> (Out, Receiver<()>) {
    let (tx, rx) = bounded::<Bytes>(OUTPUT_QUEUE);
    let (done_tx, done_rx) = bounded(1);
    thread::spawn(move || {
        let mut stdout = io::stdout().lock();
        for bytes in rx {
            if stdout
                .write_all(&bytes.data)
                .and_then(|_| stdout.flush())
                .is_err()
            {
                break;
            }
        }
        let _ = done_tx.send(());
    });
    (
        Out {
            tx,
            budget: Arc::new(AtomicUsize::new(0)),
        },
        done_rx,
    )
}

fn emit_bytes(out: &Out, bytes: Vec<u8>) -> Result<(), String> {
    let bytes = Bytes::claim(bytes, &out.budget).ok_or("stdout byte queue overflow")?;
    out.tx
        .send_timeout(bytes, OUTPUT_WAIT)
        .map_err(|_| "stdout closed or backpressured".to_owned())
}
fn emit(out: &Out, value: Value) -> Result<(), String> {
    emit_bytes(out, output::encode(&value)?)
}
fn rejection(out: &Out, id: Option<&str>, reason: &str) -> Result<(), String> {
    let mut event = json!({"type":"rejected", "reason": reason});
    if let Some(id) = id {
        event["requestId"] = id.into();
    }
    emit(out, event)
}

#[derive(Default)]
struct State {
    boot: Option<String>,
    snapshot: Option<Arc<ClientShellSnapshot>>,
    popup: Option<String>,
    requests: HashMap<String, String>,
    images: output::Images,
}
impl State {
    fn boot(&self, boot: &str) -> Result<(), String> {
        if !input::valid_id(boot) {
            return Err("invalid bootId".into());
        }
        if self.boot.as_deref() != Some(boot) {
            return Err("bootId does not match the latest snapshot".into());
        }
        Ok(())
    }
    fn command(&mut self, handle: &ClientHandle, input: Input) -> Result<(), String> {
        let sent = match input {
            Input::Input {
                boot_id,
                pane_id,
                events,
            } => {
                self.boot(&boot_id)?;
                if !input::valid_id(&pane_id) {
                    return Err("invalid paneId".into());
                }
                input::validate_events(&events)?;
                handle.send_input(&boot_id, &pane_id, events)
            }
            Input::PopupInput {
                boot_id,
                terminal_id,
                events,
            } => {
                self.boot(&boot_id)?;
                if !input::valid_id(&terminal_id) {
                    return Err("invalid terminalId".into());
                }
                input::validate_events(&events)?;
                handle.send_popup_input(&boot_id, &terminal_id, events)
            }
            Input::ClipboardImage {
                boot_id,
                target,
                encoding,
                format,
                data,
            } => {
                self.boot(&boot_id)?;
                let target = match target {
                    ImageTarget::Pane(id)
                        if input::valid_id(&id)
                            && self
                                .snapshot
                                .as_ref()
                                .is_some_and(|s| s.panes.iter().any(|p| p.pane_id == id)) =>
                    {
                        ClientClipboardImageTarget::Pane(id)
                    }
                    ImageTarget::Popup(id)
                        if input::valid_id(&id) && self.popup.as_ref() == Some(&id) =>
                    {
                        ClientClipboardImageTarget::Popup(id)
                    }
                    _ => return Err("clipboard target is not a current pane or popup".into()),
                };
                let data = input::png(&encoding, &format, &data)?;
                handle
                    .reserve_clipboard_image(&boot_id, target)
                    .and_then(|upload| upload.complete("png", data))
            }
            Input::Resize {
                boot_id,
                cols,
                rows,
                cell_width,
                cell_height,
            } => {
                self.boot(&boot_id)?;
                handle.resize(
                    &boot_id,
                    input::geometry(cols, rows, cell_width, cell_height)?,
                )
            }
            Input::Focus { boot_id, focused } => {
                self.boot(&boot_id)?;
                handle.set_focus(&boot_id, focused)
            }
            Input::Theme { boot_id, theme } => {
                self.boot(&boot_id)?;
                handle.set_host_theme(&boot_id, &theme.into_host()?)
            }
            Input::Request {
                boot_id,
                method,
                params,
                request_id,
            } => {
                self.boot(&boot_id)?;
                if !input::valid_id(&request_id) {
                    return Err("invalid requestId".into());
                }
                if self.requests.len() >= MAX_REQUESTS {
                    return Err("too many pending requests".into());
                }
                if self.requests.values().any(|id| id == &request_id) {
                    return Err("requestId is already pending".into());
                }
                let method = input::method(&method)?;
                input::validate_params(method, &params)?;
                if method == herdr_client::Method::CommandInvoke {
                    self.validate_command(&params)?;
                }
                let native_id = handle
                    .request(&boot_id, method, params)
                    .map_err(|error| error.to_string())?;
                self.requests.insert(native_id, request_id);
                return Ok(());
            }
            Input::Close => return Ok(()),
        };
        sent.map_err(|error| error.to_string())
    }
    fn validate_command(&self, params: &Value) -> Result<(), String> {
        let snapshot = self.snapshot.as_ref().ok_or("no current snapshot")?;
        let id = params
            .get("command_id")
            .and_then(Value::as_str)
            .ok_or("command_id is required")?;
        if !input::valid_id(id)
            || !snapshot
                .commands
                .iter()
                .any(|command| command.command_id == id)
        {
            return Err("command_id is not advertised in the current snapshot".into());
        }
        for field in ["workspace_id", "tab_id", "pane_id"] {
            if let Some(value) = params.get(field) {
                let id = value
                    .as_str()
                    .filter(|id| input::valid_id(id))
                    .ok_or("invalid command target")?;
                let exists = match field {
                    "workspace_id" => snapshot.workspaces.iter().any(|w| w.workspace_id == id),
                    "tab_id" => snapshot.tabs.iter().any(|t| {
                        t.tab_id == id
                            && params
                                .get("workspace_id")
                                .is_none_or(|w| w == &t.workspace_id)
                    }),
                    _ => snapshot.panes.iter().any(|p| {
                        p.pane_id == id
                            && params
                                .get("workspace_id")
                                .is_none_or(|w| w == &p.workspace_id)
                            && params.get("tab_id").is_none_or(|t| t == &p.tab_id)
                    }),
                };
                if !exists {
                    return Err("command target is not in the current snapshot hierarchy".into());
                }
            }
        }
        Ok(())
    }
    fn event(&mut self, out: &Out, event: ClientEvent) -> Result<Option<String>, String> {
        let event = match event {
            ClientEvent::Connected(welcome) => {
                json!({"type":"connected", "welcome":output::value(&welcome)?})
            }
            ClientEvent::Snapshot(snapshot) => {
                self.boot = Some(snapshot.boot_id.clone());
                if self
                    .snapshot
                    .as_ref()
                    .is_none_or(|old| old.revision != snapshot.revision)
                {
                    self.popup = None;
                }
                self.snapshot = Some(snapshot.clone());
                json!({"type":"snapshot", "snapshot":output::value(snapshot.as_ref())?})
            }
            ClientEvent::Surface(surface) => {
                output::validate_surface(&surface)?;
                if let Some(images) = self.images.before_surface(&surface)? {
                    emit_bytes(out, images)?;
                }
                self.popup = surface
                    .popup
                    .as_ref()
                    .map(|popup| popup.terminal_id.clone());
                emit_bytes(out, output::surface_line(surface.as_ref())?)?;
                return Ok(None);
            }
            ClientEvent::SurfaceImages(images) => {
                emit_bytes(out, self.images.update(images)?)?;
                return Ok(None);
            }
            ClientEvent::Message(message) => {
                json!({"type":"message", "message":output::value(&message)?})
            }
            ClientEvent::Response {
                request_id,
                response,
            } => {
                let id = self
                    .requests
                    .remove(&request_id)
                    .ok_or("response has no caller request correlation")?;
                json!({"type":"response", "requestId":id, "response":output::value(&response)?})
            }
            ClientEvent::CommandRejected { request_id, reason } => {
                let id = request_id.and_then(|id| self.requests.remove(&id));
                rejection(out, id.as_deref(), &reason.to_string())?;
                return Ok(None);
            }
            // Disconnected immediately follows and contains the handshake error.
            ClientEvent::VersionMismatch(_) => return Ok(None),
            ClientEvent::Disconnected { reason, .. } => return Ok(Some(reason)),
        };
        emit(out, event)?;
        Ok(None)
    }
}

fn correlation(line: &[u8]) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Header {
        #[serde(rename = "requestId")]
        request_id: Option<String>,
    }
    serde_json::from_slice::<Header>(line)
        .ok()?
        .request_id
        .filter(|id| input::valid_id(id))
}

fn run(args: Args) -> Result<(), String> {
    let (lines, end) = stdin_worker();
    let (out, writer_done) = stdout_worker();
    let socket = args.socket;
    // Explicit Socket target and connector only. Do not invoke discovery,
    // connect(), remote bridges, CLI fallback, or any local server launcher.
    let client = connect_with_connector(
        ConnectTarget::Socket(socket.clone()),
        args.options,
        true,
        move |_, stop| {
            if stop.load(Ordering::Acquire) {
                return Err(io::Error::from(io::ErrorKind::Interrupted));
            }
            UnixStream::connect(socket)
        },
    )
    .map_err(|_| "could not start native client")?;
    let mut state = State::default();
    let result: Result<String, String> = (|| loop {
        if let Ok(reason) = end.try_recv() {
            break Ok(reason);
        }
        select! {
            recv(end) -> reason => break Ok(reason.unwrap_or_else(|_| "stdin closed".into())),
            recv(writer_done) -> _ => break Err("stdout closed".into()),
            recv(lines) -> line => {
                let Ok(line) = line else { break Ok("stdin closed".into()); };
                let id = correlation(&line.data);
                match input::parse(&line.data) {
                    Ok(Input::Close) => break Ok("client closed".into()),
                    Ok(input) => {
                        if let Err(reason) = state.command(&client.handle, input) {
                            rejection(&out, id.as_deref(), &reason)?;
                        }
                    }
                    Err(reason) => rejection(&out, id.as_deref(), reason)?,
                }
            }
            recv(client.events) -> event => {
                let Ok(event) = event else { break Ok("native client closed".into()); };
                if let Some(reason) = state.event(&out, event)? { break Ok(reason); }
            }
        }
    })();
    client.handle.disconnect();
    let reason = match &result {
        Ok(reason) | Err(reason) => reason,
    };
    let _ = emit(&out, json!({"type":"closed", "reason":reason}));
    drop(out);
    // Never join a worker blocked on stdout. Exiting closes the socket even if
    // the owner stopped draining stdout. EOF/detach is bounded independently.
    let _ = writer_done.recv_timeout(OUTPUT_WAIT);
    result.map(|_| ())
}
