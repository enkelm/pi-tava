//! Only disposable synthetic endpoints. Never launch Herdr or discover sockets.
use crossbeam_channel::{Receiver, unbounded};
use herdr_protocol::{endpoint::*, *};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    process::{Child, ChildStdin, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

const WAIT: Duration = Duration::from_secs(4);
struct Peer {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Receiver<Value>,
    socket: UnixStream,
    _dir: TempDir,
}
impl Drop for Peer {
    fn drop(&mut self) {
        // This is only the helper child created by this fixture, not a daemon.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Peer {
    fn new() -> Self {
        Self::with_stdout_reader(true)
    }
    fn with_stdout_reader(drain: bool) -> Self {
        let dir = tempfile::Builder::new()
            .prefix("herdr-web-test-")
            .tempdir_in("/tmp")
            .unwrap();
        let path = dir.path().join("herdr-client.sock");
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_herdr-web"))
            .env_clear()
            .arg("--socket")
            .arg(&path)
            .args(["--cols", "80", "--rows", "24"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let (tx, stdout) = unbounded();
        if drain {
            let output = child.stdout.take().unwrap();
            thread::spawn(move || {
                for line in BufReader::new(output).lines() {
                    let Ok(line) = line else {
                        break;
                    };
                    let Ok(value) = serde_json::from_str(&line) else {
                        break;
                    };
                    if tx.send(value).is_err() {
                        break;
                    }
                }
            });
        }
        let deadline = Instant::now() + WAIT;
        let socket = loop {
            if let Ok((socket, _)) = listener.accept() {
                break socket;
            }
            assert!(Instant::now() < deadline, "helper did not connect");
            thread::sleep(Duration::from_millis(5));
        };
        socket.set_nonblocking(false).unwrap();
        socket.set_read_timeout(Some(WAIT)).unwrap();
        socket.set_write_timeout(Some(WAIT)).unwrap();
        Self {
            stdin: child.stdin.take(),
            child,
            stdout,
            socket,
            _dir: dir,
        }
    }
    fn recv(&mut self) -> ClientMessage {
        read_message(&mut self.socket, MAX_FRAME_SIZE).unwrap()
    }
    fn send(&mut self, message: ServerMessage) {
        write_message(&mut self.socket, &message, MAX_GRAPHICS_FRAME_SIZE).unwrap();
    }
    fn input(&mut self, value: Value) {
        writeln!(self.stdin.as_mut().unwrap(), "{value}").unwrap();
    }
    fn event(&self) -> Value {
        self.stdout.recv_timeout(WAIT).expect("missing JSONL event")
    }
    fn typed(&self, kind: &str) -> Value {
        for _ in 0..16 {
            let value = self.event();
            if value["type"] == kind {
                return value;
            }
            assert_ne!(value["type"], "closed", "unexpected close: {value}");
        }
        panic!("missing {kind}");
    }
    fn hello(&mut self) {
        let ClientMessage::EndpointControl { kind, data } = self.recv() else {
            panic!("missing binary hello");
        };
        assert_eq!(kind, ENDPOINT_HELLO_KIND);
        let hello: EndpointClientHello = serde_json::from_str(&data).unwrap();
        assert_eq!(hello.surface_size, ClientSurfaceSize { cols: 80, rows: 24 });
        assert!(
            hello.surface_active
                && hello.surface_reuse
                && hello.surface_delta
                && hello.surface_scroll
        );
        assert!(!hello.direct_graphics && !hello.endpoint_keybindings);
    }
    fn ready(&mut self) {
        self.hello();
        // Split the little-endian header, then a payload part. The real client
        // must retain both between reads instead of dropping incomplete frames.
        let bytes = encode_message(&welcome(), MAX_FRAME_SIZE).unwrap();
        self.socket.write_all(&bytes[..2]).unwrap();
        thread::sleep(Duration::from_millis(20));
        self.socket.write_all(&bytes[2..7]).unwrap();
        thread::sleep(Duration::from_millis(20));
        self.socket.write_all(&bytes[7..]).unwrap();
        self.send(snapshot(7, "boot-v1"));
        assert_eq!(self.event()["type"], "connected");
        let snapshot = self.event();
        assert_eq!(snapshot["type"], "snapshot");
        assert_eq!(snapshot["snapshot"]["commands"][0]["action"], "Shell");
    }
    fn exited(&mut self) {
        let deadline = Instant::now() + WAIT;
        loop {
            if self.child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "helper failed to exit");
            thread::sleep(Duration::from_millis(10));
        }
    }
}
fn control(kind: &str, data: String) -> ServerMessage {
    ServerMessage::EndpointControl {
        kind: kind.into(),
        data,
    }
}
fn welcome() -> ServerMessage {
    control(ENDPOINT_WELCOME_KIND, json!({
        "generation":1,"server_version":"0.9.1","snapshot_codec":SNAPSHOT_CODEC_V1,
        "surface_codec":SURFACE_CODEC_V1,"input_codec":INPUT_CODEC_V1,"blob_codec":BLOB_CODEC_V1,
        "methods":["pane.focus","command.invoke"],"capabilities":["surface_reuse","surface_delta","surface_scroll"]
    }).to_string())
}
fn snapshot(revision: u64, boot: &str) -> ServerMessage {
    let mut snapshot: Value =
        serde_json::from_str(include_str!("fixtures/endpoint-snapshot-v1.json")).unwrap();
    snapshot["revision"] = revision.into();
    snapshot["boot_id"] = boot.into();
    control(ENDPOINT_SNAPSHOT_KIND, snapshot.to_string())
}
fn cell(symbol: &str) -> CellData {
    CellData {
        symbol: symbol.into(),
        fg: 0x02123456,
        bg: 0x01000001,
        modifier: 5,
        skip: false,
        hyperlink: Some(0),
    }
}
fn baseline() -> PaneSurfaceFrame {
    PaneSurfaceFrame {
        boot_id: "boot-v1".into(),
        projection_revision: 7,
        surface_revision: 1,
        frame: FrameData {
            width: 2,
            height: 2,
            cells: vec![cell("x"); 4],
            cursor: Some(CursorState {
                x: 0,
                y: 1,
                visible: true,
                shape: 5,
            }),
            hyperlinks: vec!["https://example.invalid".into()],
            graphics: vec![],
        },
        panes: vec![],
        splits: vec![],
        popup: None,
        graphics: SurfaceGraphicsScene::default(),
    }
}
fn patch(base: u64, projection: u64) -> PaneSurfacePatch {
    PaneSurfacePatch {
        boot_id: "boot-v1".into(),
        projection_revision: projection,
        base_surface_revision: base,
        surface_revision: base + 1,
        rows: vec![PaneSurfacePatchRow {
            x: 1,
            y: 0,
            cells: vec![cell("λ")],
        }],
        panes: vec![],
        cursor: None,
    }
}

#[test]
fn binary_handshake_semantic_input_resize_request_chunks_and_patch() {
    let mut p = Peer::new();
    p.ready();
    p.send(ServerMessage::PaneSurface(baseline()));
    assert_eq!(p.typed("surface")["surface"]["frame"]["cursor"]["shape"], 5);
    p.send(ServerMessage::PaneSurfacePatch(patch(1, 7)));
    let surface = p.typed("surface");
    assert_eq!(surface["surface"]["surface_revision"], 2);
    assert_eq!(surface["surface"]["frame"]["cells"][1]["symbol"], "λ");
    assert_eq!(
        surface["surface"]["frame"]["cells"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(surface["surface"]["frame"]["cells"][0]["symbol"], "x");
    let events = json!([
        {"TextCommit":"hello λ"}, {"Paste":"line1\nline2"},
        {"Key":{"code":"Enter","modifiers":2,"kind":"Press","repeat_count":1,"shifted_codepoint":null,"generated_text":null,"tracks_release":true,"physical_key_id":13,"windows_record":null}},
        {"Mouse":{"kind":{"Down":"Left"},"position":{"Cell":{"column":1,"row":0}},"geometry":null,"modifiers":0,"lines":1}}
    ]);
    p.input(json!({"type":"input","bootId":"boot-v1","paneId":"w1:p1","events":events}));
    let ClientMessage::ClientShellPaneInput {
        pane_id,
        events: wire_events,
    } = p.recv()
    else {
        panic!("semantic framing lost");
    };
    assert_eq!(pane_id, "w1:p1");
    assert_eq!(serde_json::to_value(wire_events).unwrap(), events);
    p.input(json!({"type":"resize","bootId":"boot-v1","cols":120,"rows":32,"cellWidth":8,"cellHeight":16}));
    assert!(matches!(
        p.recv(),
        ClientMessage::ClientShellResize {
            surface_size: ClientSurfaceSize {
                cols: 120,
                rows: 32
            },
            cell_width_px: 8,
            cell_height_px: 16,
            pixel_mouse: false
        }
    ));
    p.input(json!({"type":"request","bootId":"boot-v1","method":"pane.focus","params":{"pane_id":"w1:p1"},"requestId":"caller-1"}));
    let ClientMessage::ClientShellEndpointRequest { request, .. } = p.recv() else {
        panic!("request missing");
    };
    let request: Value = serde_json::from_str(&request).unwrap();
    let id = request["id"].as_str().unwrap();
    let response = json!({"id":id,"result":{"focused":true}}).to_string();
    let mid = response.len() / 2;
    for (final_chunk, data) in [
        (false, &response.as_bytes()[..mid]),
        (true, &response.as_bytes()[mid..]),
    ] {
        p.send(ServerMessage::ClientShellEndpointResponseChunk {
            boot_id: "boot-v1".into(),
            request_id: id.into(),
            final_chunk,
            data: data.to_vec(),
        });
    }
    let event = p.event();
    assert_eq!(event["type"], "response");
    assert_eq!(event["requestId"], "caller-1");
    assert_eq!(event["response"]["id"], id);
    assert_eq!(event["response"]["result"]["focused"], true);
    // There has been no helper event claiming input was acknowledged.
    assert!(p.stdout.recv_timeout(Duration::from_millis(50)).is_err());
}

#[test]
fn upstream_and_local_rejections_keep_caller_correlation() {
    let mut p = Peer::new();
    p.ready();
    for (method, boot, id) in [
        ("tab.focus", "boot-v1", "unadvertised"),
        ("command.invoke", "boot-v1", "disallowed"),
        ("pane.focus", "old-boot", "stale"),
    ] {
        p.input(json!({"type":"request","bootId":boot,"method":method,"params":{},"requestId":id}));
        let rejected = p.event();
        assert_eq!(rejected["type"], "rejected");
        assert_eq!(rejected["requestId"], id);
    }
    p.input(json!({"type":"input","bootId":"old-boot","paneId":"w1:p1","events":[{"TextCommit":"not sent"}]}));
    let event = p.event();
    assert_eq!(event["type"], "rejected");
    assert!(event.get("requestId").is_none());
    p.socket
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    assert!(p.socket.read(&mut [0; 1]).is_err());
}

#[test]
fn compressed_delta_reuse_and_scroll_are_reconstructed_by_client() {
    use herdr_protocol::{
        surface_delta::SurfaceDelta,
        surface_reuse::SurfaceReuse,
        surface_scroll::{ScrollPatch, SurfaceScroll},
    };
    let mut p = Peer::new();
    p.ready();
    let base = baseline();
    p.send(ServerMessage::PaneSurface(base.clone()));
    p.typed("surface");
    let mut next = base.clone();
    next.surface_revision = 2;
    next.frame.cells.clear();
    let delta = SurfaceDelta {
        base_projection_revision: 7,
        base_surface_revision: 1,
        surface: next,
        rows: patch(1, 7).rows,
        popup_cells: None,
    };
    p.send(control(
        surface_delta::MESSAGE_KIND,
        delta.encode().unwrap(),
    ));
    let v = p.typed("surface");
    assert_eq!(v["surface"]["frame"]["cells"][1]["symbol"], "λ");
    let mut next = base.clone();
    next.surface_revision = 3;
    next.frame.cells.clear();
    p.send(control(
        surface_reuse::MESSAGE_KIND,
        SurfaceReuse {
            base_surface_revision: 2,
            surface: next,
        }
        .encode()
        .unwrap(),
    ));
    let v = p.typed("surface");
    assert_eq!(v["surface"]["frame"]["cells"][1]["symbol"], "λ");
    let scroll = ScrollPatch {
        scrolls: vec![SurfaceScroll {
            rect: SurfaceRect {
                x: 0,
                y: 0,
                width: 2,
                height: 2,
            },
            shift: 1,
        }],
        patch: PaneSurfacePatch {
            rows: vec![PaneSurfacePatchRow {
                x: 0,
                y: 1,
                cells: vec![cell("z"); 2],
            }],
            ..patch(3, 7)
        },
    };
    p.send(control(
        surface_scroll::MESSAGE_KIND,
        scroll.encode().unwrap(),
    ));
    let v = p.typed("surface");
    assert_eq!(v["surface"]["surface_revision"], 4);
    assert_eq!(v["surface"]["frame"]["cells"][2]["symbol"], "z");
}

#[test]
fn images_preserve_formats_exact_keys_and_popup_frames() {
    let mut p = Peer::new();
    p.ready();
    let mut surface = baseline();
    surface.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: "popup-1".into(),
        title: "Popup".into(),
        width: Some(ClientShellPopupSize::Percent(80)),
        height: None,
        frame: surface.frame.clone(),
        mouse_reporting: true,
        sgr_pixel_mouse: false,
        pixel_width: 16,
        pixel_height: 32,
    }));
    for (index, (format, data)) in [
        (SurfaceGraphicsFormat::Rgb, vec![1, 2, 3]),
        (SurfaceGraphicsFormat::Rgba, vec![1, 2, 3, 4]),
        (SurfaceGraphicsFormat::Png, vec![137, 80, 78, 71]),
    ]
    .into_iter()
    .enumerate()
    {
        let key = SurfaceGraphicsAssetKey {
            source: SurfaceGraphicsSource::Terminal {
                target: SurfaceGraphicsTarget::Pane {
                    pane_id: "w1:p1".into(),
                },
                image_id: index as u32,
            },
            image_width: 1,
            image_height: 1,
            format,
            data_len: data.len() as u64,
            data_fingerprint: u64::MAX - index as u64,
        };
        surface.graphics.assets.push(SurfaceGraphicsAsset {
            key: key.clone(),
            data,
        });
        surface.graphics.placements.push(SurfaceGraphicsPlacement {
            asset: key,
            logical_placement_id: 0,
            x: 0,
            y: 0,
            cols: 1,
            rows: 1,
            source_x: 0,
            source_y: 0,
            source_width: 1,
            source_height: 1,
            x_offset: 0,
            y_offset: 0,
            z: -1,
            scrollback_offset: 0,
        });
    }
    p.send(ServerMessage::PaneSurface(surface));
    let mut images = Value::Null;
    let surface = loop {
        let v = p.event();
        match v["type"].as_str() {
            Some("images") => images = v["images"].clone(),
            Some("surface") => break v["surface"].clone(),
            _ => panic!("unexpected {v}"),
        }
    };
    assert_eq!(images.as_array().unwrap().len(), 3);
    assert_eq!(images[0]["encoding"], "base64");
    assert_eq!(images[0]["data"], "AQID");
    assert_eq!(images[0]["key"]["data_fingerprint"], "18446744073709551615");
    for (index, format) in ["Rgb", "Rgba", "Png"].into_iter().enumerate() {
        assert_eq!(images[index]["key"]["format"], format);
        assert_eq!(
            images[index]["key"],
            surface["graphics"]["placements"][index]["asset"]
        );
    }
    assert_eq!(surface["graphics"]["assets"], json!([]));
    assert_eq!(
        surface["popup"]["frame"]["cells"].as_array().unwrap().len(),
        4
    );
    p.input(json!({"type":"popup-input","bootId":"boot-v1","terminalId":"popup-1","events":[{"Paste":"popup text"}]}));
    assert!(
        matches!(p.recv(), ClientMessage::ClientShellPopupInput {terminal_id,..} if terminal_id=="popup-1")
    );
}

#[test]
fn all_non_surface_messages_and_theme_focus_pass_through() {
    let mut p = Peer::new();
    p.ready();
    for message in [
        ServerMessage::Clipboard {
            data: "synthetic clipboard".into(),
        },
        ServerMessage::WindowTitle {
            title: Some("title".into()),
        },
        ServerMessage::TerminalBell { count: 2 },
        ServerMessage::MouseCapture {
            enabled: true,
            sgr_pixels: true,
        },
        ServerMessage::ClientShellKeyboardReportAll { enabled: true },
        ServerMessage::ReloadSoundConfig,
        ServerMessage::GraphicsFile {
            path: "/never/read/this".into(),
            expected_len: 1,
            image_id: 1,
            transfer_id: 2,
            leading: vec![],
            control: "".into(),
            surface_asset: None,
        },
    ] {
        let expected = serde_json::to_value(&message).unwrap();
        p.send(message);
        assert_eq!(p.event(), json!({"type":"message","message":expected}));
    }
    p.input(json!({"type":"focus","bootId":"boot-v1","focused":true}));
    assert!(matches!(
        p.recv(),
        ClientMessage::ClientShellFocus { focused: true }
    ));
    p.input(json!({"type":"theme","bootId":"boot-v1","theme":{"foreground":{"r":255,"g":255,"b":255},"background":{"r":0,"g":0,"b":0},"palette":vec![json!({"r":0,"g":0,"b":0});256],"appearance":"Dark"}}));
    for _ in 0..4 {
        assert!(matches!(
            p.recv(),
            ClientMessage::ClientShellHostTheme { .. }
        ));
    }
}

#[test]
fn future_projection_waits_for_snapshot_and_keeps_patch() {
    let mut p = Peer::new();
    p.ready();
    let mut surface = baseline();
    surface.projection_revision = 9;
    p.send(ServerMessage::PaneSurface(surface));
    p.send(ServerMessage::PaneSurfacePatch(patch(1, 9)));
    assert!(p.stdout.recv_timeout(Duration::from_millis(70)).is_err());
    p.send(snapshot(9, "boot-v1"));
    assert_eq!(p.event()["type"], "snapshot");
    let v = p.event();
    assert_eq!(v["surface"]["projection_revision"], 9);
    assert_eq!(v["surface"]["surface_revision"], 2);
}

#[test]
fn partial_boot_change_fences_queued_input() {
    let mut p = Peer::new();
    p.ready();
    let bytes = encode_message(&snapshot(8, "replacement-boot"), MAX_FRAME_SIZE).unwrap();
    p.socket.write_all(&bytes[..5]).unwrap();
    thread::sleep(Duration::from_millis(50));
    p.input(json!({"type":"input","bootId":"boot-v1","paneId":"w1:p1","events":[{"TextCommit":"must not reach peer"}]}));
    thread::sleep(Duration::from_millis(50));
    p.socket.write_all(&bytes[5..]).unwrap();
    let close = p.typed("closed");
    assert!(close["reason"].as_str().unwrap().contains("boot changed"));
    p.exited();
    assert_eq!(p.socket.read(&mut [0; 1]).unwrap(), 0);
}

#[test]
fn invalid_patch_or_oversize_binary_frame_closes_without_repair() {
    for oversized in [false, true] {
        let mut p = Peer::new();
        p.ready();
        if oversized {
            p.socket.write_all(&u32::MAX.to_le_bytes()).unwrap();
        } else {
            p.send(ServerMessage::PaneSurface(baseline()));
            p.typed("surface");
            p.send(ServerMessage::PaneSurfacePatch(patch(99, 7)));
        }
        assert_eq!(p.typed("closed")["type"], "closed");
        p.exited();
    }
}

#[test]
fn eof_exits_even_when_stdout_is_not_drained() {
    let mut p = Peer::with_stdout_reader(false);
    p.hello();
    p.send(welcome());
    p.send(snapshot(7, "boot-v1"));
    p.send(ServerMessage::Clipboard {
        data: "x".repeat(256 * 1024),
    });
    thread::sleep(Duration::from_millis(100));
    p.stdin.take();
    p.exited();
    assert_eq!(p.socket.read(&mut [0; 1]).unwrap(), 0);
}

#[test]
fn stdin_schema_rejection_does_not_forward_invalid_semantic_events() {
    let mut p = Peer::new();
    p.ready();
    p.input(json!({"type":"input","bootId":"boot-v1","paneId":"w1:p1","events":[{"Key":{"code":"Enter","modifiers":0,"kind":"Press","repeat_count":1,"tracks_release":false,"unexpected":true}}]}));
    assert_eq!(p.event()["type"], "rejected");
    p.input(json!({"type":"request","bootId":"boot-v1","requestId":"schema-1","method":"pane.focus","params":{},"unexpected":true}));
    let event = p.event();
    assert_eq!(event["type"], "rejected");
    assert_eq!(event["requestId"], "schema-1");
    p.input(json!({"type":"resize","bootId":"boot-v1","cols":513,"rows":24,"cellWidth":8,"cellHeight":16}));
    assert_eq!(p.event()["type"], "rejected");
    p.socket
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    assert!(p.socket.read(&mut [0; 1]).is_err());
}

#[test]
fn configured_commands_require_current_snapshot_ids_and_explicit_requests() {
    let mut p = Peer::new();
    p.ready();
    // Merely receiving configured shell command metadata emitted no invocation.
    p.socket
        .set_read_timeout(Some(Duration::from_millis(60)))
        .unwrap();
    assert!(p.socket.read(&mut [0; 1]).is_err());
    p.socket.set_read_timeout(Some(WAIT)).unwrap();
    for params in [
        json!({"command_id":"unadvertised"}),
        json!({"command_id":"command-v1","command":"arbitrary shell"}),
        json!({"command_id":"command-v1","pane_id":"missing"}),
    ] {
        p.input(json!({"type":"request","bootId":"boot-v1","method":"command.invoke","params":params,"requestId":"invalid-command"}));
        let rejected = p.event();
        assert_eq!(rejected["type"], "rejected");
        assert_eq!(rejected["requestId"], "invalid-command");
    }
    p.input(json!({"type":"request","bootId":"boot-v1","method":"command.invoke","params":{"command_id":"command-v1","workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1"},"requestId":"configured"}));
    let ClientMessage::ClientShellEndpointRequest { request, .. } = p.recv() else {
        panic!("missing configured invocation");
    };
    let request: Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["method"], "command.invoke");
    assert_eq!(request["params"]["command_id"], "command-v1");
    let id = request["id"].as_str().unwrap();
    p.send(ServerMessage::ClientShellEndpointResponseChunk {
        boot_id: "boot-v1".into(),
        request_id: id.into(),
        final_chunk: true,
        data: json!({"id":id,"result":{}}).to_string().into_bytes(),
    });
    assert_eq!(p.event()["requestId"], "configured");
    let mut next: Value =
        serde_json::from_str(include_str!("fixtures/endpoint-snapshot-v1.json")).unwrap();
    next["revision"] = 8.into();
    next["commands"] = json!([]);
    p.send(control(ENDPOINT_SNAPSHOT_KIND, next.to_string()));
    p.typed("snapshot");
    p.input(json!({"type":"request","bootId":"boot-v1","method":"command.invoke","params":{"command_id":"command-v1"},"requestId":"removed-command"}));
    let event = p.event();
    assert_eq!(event["type"], "rejected");
    assert_eq!(event["requestId"], "removed-command");
}

#[test]
fn png_clipboard_is_native_framed_and_bound_to_known_pane_or_popup() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let mut p = Peer::new();
    p.ready();
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
    let input = |target| json!({"type":"clipboard-image","bootId":"boot-v1","target":target,"encoding":"base64","format":"png","data":png});
    p.input(input(json!({"Pane":"w1:p1"})));
    let ClientMessage::ClipboardImage {
        target,
        extension,
        data,
    } = p.recv()
    else {
        panic!("missing native clipboard image");
    };
    assert_eq!(target, ClientClipboardImageTarget::Pane("w1:p1".into()));
    assert_eq!(extension, "png");
    assert_eq!(data, STANDARD.decode(png).unwrap());
    assert!(p.stdout.recv_timeout(Duration::from_millis(30)).is_err());
    for target in [
        json!({"Pane":"missing"}),
        json!({"Popup":"missing"}),
        json!("DirectTerminal"),
    ] {
        p.input(input(target));
        assert_eq!(p.event()["type"], "rejected");
    }
    let mut surface = baseline();
    surface.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: "popup-1".into(),
        title: "popup".into(),
        width: None,
        height: None,
        frame: surface.frame.clone(),
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        pixel_width: 16,
        pixel_height: 32,
    }));
    p.send(ServerMessage::PaneSurface(surface));
    p.typed("surface");
    p.input(input(json!({"Popup":"popup-1"})));
    assert!(
        matches!(p.recv(),ClientMessage::ClipboardImage {target:ClientClipboardImageTarget::Popup(id),..} if id=="popup-1")
    );
    p.send(snapshot(8, "boot-v1"));
    p.typed("snapshot");
    p.input(input(json!({"Popup":"popup-1"})));
    assert_eq!(p.event()["type"], "rejected");
    let mut invalid = input(json!({"Pane":"w1:p1"}));
    invalid["data"] = "not a PNG".into();
    p.input(invalid);
    assert_eq!(p.event()["type"], "rejected");
}

#[test]
fn eof_close_and_oversize_stdin_detach_even_during_handshake() {
    for mode in ["eof", "close", "oversize"] {
        let mut p = Peer::new();
        p.hello();
        match mode {
            "eof" => {
                p.stdin.take();
            }
            "close" => p.input(json!({"type":"close"})),
            _ => {
                let _ = p
                    .stdin
                    .as_mut()
                    .unwrap()
                    .write_all(&vec![b'x'; 24 * 1024 * 1024 + 1]);
            }
        }
        assert_eq!(p.typed("closed")["type"], "closed");
        p.exited();
        assert_eq!(p.socket.read(&mut [0; 1]).unwrap(), 0);
    }
}
