use base64::{Engine, engine::general_purpose::STANDARD};
use herdr_client::{ConnectOptions, HostTheme, Method};
use herdr_protocol::{
    ClientHostAppearance, ClientHostColor, ClientPaneInputEvent, ClientSurfaceSize,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead};

pub const MAX_LINE: usize = 24 * 1024 * 1024;
pub const MAX_COMMAND_LINE: usize = 1024 * 1024;
pub const MAX_CLIPBOARD: usize = 8 * 1024 * 1024;
pub const MAX_EVENTS: usize = 256;
pub const MAX_COLS: u16 = 512;
pub const MAX_ROWS: u16 = 256;
pub const MAX_CELLS: usize = 131_072;
pub const MAX_ID: usize = 256;

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Input {
    Input {
        boot_id: String,
        pane_id: String,
        events: Vec<ClientPaneInputEvent>,
    },
    PopupInput {
        boot_id: String,
        terminal_id: String,
        events: Vec<ClientPaneInputEvent>,
    },
    ClipboardImage {
        boot_id: String,
        target: ImageTarget,
        encoding: String,
        format: String,
        data: String,
    },
    Resize {
        boot_id: String,
        cols: u16,
        rows: u16,
        cell_width: u32,
        cell_height: u32,
    },
    Request {
        boot_id: String,
        method: String,
        params: Value,
        request_id: String,
    },
    Focus {
        boot_id: String,
        focused: bool,
    },
    Theme {
        boot_id: String,
        theme: Theme,
    },
    Close,
}

#[derive(Debug, Deserialize, Serialize)]
pub enum ImageTarget {
    Pane(String),
    Popup(String),
}

pub fn png(encoding: &str, format: &str, data: &str) -> Result<Vec<u8>, &'static str> {
    if encoding != "base64" || format != "png" || data.len() > MAX_CLIPBOARD.div_ceil(3) * 4 {
        return Err("clipboard image must be base64 PNG, at most 8 MiB decoded");
    }
    let data = STANDARD
        .decode(data)
        .map_err(|_| "invalid clipboard base64")?;
    if data.len() > MAX_CLIPBOARD
        || data.len() < 33
        || &data[..8] != b"\x89PNG\r\n\x1a\n"
        || &data[8..16] != b"\x00\x00\x00\x0dIHDR"
    {
        return Err("invalid or oversized PNG clipboard image");
    }
    let width = u32::from_be_bytes(data[16..20].try_into().map_err(|_| "invalid PNG width")?);
    let height = u32::from_be_bytes(data[20..24].try_into().map_err(|_| "invalid PNG height")?);
    if width == 0
        || height == 0
        || width > 10_000
        || height > 10_000
        || u64::from(width) * u64::from(height) > 16_777_216
    {
        return Err("PNG clipboard dimensions exceed limits");
    }
    Ok(data)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Theme {
    foreground: ClientHostColor,
    background: ClientHostColor,
    palette: Vec<ClientHostColor>,
    appearance: ClientHostAppearance,
}
impl Theme {
    pub fn into_host(self) -> Result<HostTheme, &'static str> {
        Ok(HostTheme {
            foreground: self.foreground,
            background: self.background,
            palette: self
                .palette
                .try_into()
                .map_err(|_| "theme palette must contain 256 colors")?,
            appearance: self.appearance,
        })
    }
}

/// Fill at most MAX_LINE bytes, even if the sender never supplies a newline.
/// EOF with a partial line is not a command: the owner has already detached.
pub fn read_line(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(None);
        }
        let newline = chunk.iter().position(|&byte| byte == b'\n');
        let count = newline.unwrap_or(chunk.len());
        if count > MAX_LINE.saturating_sub(line.len()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "stdin line exceeds 24 MiB",
            ));
        }
        line.extend_from_slice(&chunk[..count]);
        reader.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some(line));
        }
    }
}

pub fn parse(bytes: &[u8]) -> Result<Input, &'static str> {
    #[derive(Deserialize)]
    struct Tag {
        r#type: String,
    }
    if bytes.len() > MAX_COMMAND_LINE {
        let tag: Tag = serde_json::from_slice(bytes).map_err(|_| "invalid input schema")?;
        if tag.r#type != "clipboard-image" {
            return Err("command line exceeds 1 MiB");
        }
    }
    let input: Input = serde_json::from_slice(bytes).map_err(|_| "invalid input schema")?;
    // This variant has no permissive upstream structs. Avoid cloning its large
    // base64 payload through Value/canonical trees just to check unknown fields.
    if matches!(input, Input::ClipboardImage { .. }) {
        return Ok(input);
    }
    let original: Value = serde_json::from_slice(bytes).map_err(|_| "invalid input JSON")?;
    let canonical = serde_json::to_value(&input).map_err(|_| "invalid input schema")?;
    // Upstream types do not deny unknown fields. An internally tagged enum
    // buffers nested data, so serde_ignored alone cannot catch those fields.
    if has_unknown_fields(&original, &canonical) {
        return Err("unknown input field");
    }
    Ok(input)
}
fn has_unknown_fields(original: &Value, canonical: &Value) -> bool {
    match (original, canonical) {
        (Value::Object(a), Value::Object(b)) => a.iter().any(|(key, value)| {
            b.get(key)
                .is_none_or(|expected| has_unknown_fields(value, expected))
        }),
        (Value::Array(a), Value::Array(b)) => {
            a.iter().zip(b).any(|(a, b)| has_unknown_fields(a, b))
        }
        _ => false,
    }
}

pub fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID && !value.chars().any(char::is_control)
}

pub fn geometry(
    cols: u16,
    rows: u16,
    cell_width: u32,
    cell_height: u32,
) -> Result<ConnectOptions, &'static str> {
    if cols == 0
        || rows == 0
        || cols > MAX_COLS
        || rows > MAX_ROWS
        || usize::from(cols) * usize::from(rows) > MAX_CELLS
        || cell_width > 4096
        || cell_height > 4096
    {
        return Err("geometry exceeds helper limits");
    }
    Ok(ConnectOptions {
        surface_size: ClientSurfaceSize { cols, rows },
        cell_width_px: cell_width,
        cell_height_px: cell_height,
    })
}

pub fn validate_events(events: &[ClientPaneInputEvent]) -> Result<(), &'static str> {
    if events.is_empty() || events.len() > MAX_EVENTS {
        return Err("input must contain 1..256 events");
    }
    for event in events {
        match event {
            ClientPaneInputEvent::Key {
                modifiers,
                repeat_count,
                shifted_codepoint,
                ..
            } => {
                if *modifiers > 63
                    || *repeat_count == 0
                    || shifted_codepoint.is_some_and(|cp| char::from_u32(cp).is_none())
                {
                    return Err("invalid key modifiers, repeat count, or codepoint");
                }
            }
            ClientPaneInputEvent::Mouse {
                modifiers,
                geometry: size,
                ..
            } => {
                if *modifiers > 63 {
                    return Err("invalid mouse modifiers");
                }
                if let Some(size) = size {
                    geometry(size.cols, size.rows, 0, 0)?;
                    if size.width_px > 2_097_152 || size.height_px > 1_048_576 {
                        return Err("mouse geometry exceeds helper limits");
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// No string reaches the client's request method without this closed enum map.
/// Integrations, config reload, external editor and external link activation
/// are deliberately not reachable. command.invoke requires snapshot validation.
pub fn method(name: &str) -> Result<Method, &'static str> {
    use Method::*;
    const ALLOWED: &[Method] = &[
        ClientShellSurfaceSet,
        CommandInvoke,
        LayoutSetSplitRatio,
        PaneClear,
        PaneClose,
        PaneCopyMotion,
        PaneCopySearch,
        PaneFocus,
        PaneFocusDirection,
        PaneInputSet,
        PaneLinkResolve,
        PaneRename,
        PaneResize,
        PaneScroll,
        PaneSelectionRead,
        PaneSplit,
        PaneSwap,
        PaneZoom,
        ProductAnnouncementDismiss,
        ReleaseNotesDismiss,
        TabClose,
        TabCreate,
        TabFocus,
        TabMove,
        TabRename,
        WorkspaceClose,
        WorkspaceCreate,
        WorkspaceFocus,
        WorkspaceMoveBlock,
        WorkspaceRename,
        WorktreeCreate,
        WorktreeList,
        WorktreeOpen,
        WorktreeRemove,
    ];
    ALLOWED
        .iter()
        .copied()
        .find(|m| m.as_str() == name)
        .ok_or("method is not allowed")
}

pub fn validate_params(method: Method, params: &Value) -> Result<(), &'static str> {
    let fields = params
        .as_object()
        .ok_or("request params must be an object")?;
    // Creation APIs also support execution options upstream. Only layout fields
    // are exposed here; raw terminal execution belongs to explicit semantic input.
    let allowed: Option<&[&str]> = match method {
        Method::CommandInvoke => Some(&[
            "command_id",
            "workspace_id",
            "tab_id",
            "pane_id",
            "selection",
        ]),
        Method::PaneSplit => Some(&["target_pane_id", "direction", "cwd", "focus", "label"]),
        Method::TabCreate => Some(&["workspace_id", "cwd", "focus", "label"]),
        Method::WorkspaceCreate => Some(&["source_workspace_id", "cwd", "focus", "label"]),
        Method::WorktreeCreate => Some(&[
            "workspace_id",
            "base",
            "branch",
            "focus",
            "trust_repository",
        ]),
        Method::WorktreeOpen => Some(&["workspace_id", "path", "focus", "trust_repository"]),
        Method::WorktreeRemove => Some(&["workspace_id", "force", "trust_repository"]),
        _ => None,
    };
    if allowed.is_some_and(|allowed| fields.keys().any(|key| !allowed.contains(&key.as_str()))) {
        return Err("request contains unsupported creation parameters");
    }
    if fields
        .get("trust_repository")
        .is_some_and(|v| v != &Value::Bool(false))
    {
        return Err("repository script trust is not exposed by this helper");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_schema_and_methods() {
        assert!(
            parse(br#"{"type":"input","bootId":"b","paneId":"p","events":[{"TextCommit":"ok"}]}"#)
                .is_ok()
        );
        assert!(parse(br#"{"type":"close","extra":true}"#).is_err());
        assert!(parse(br#"{"type":"focus","bootId":"b","focused":true} {}"#).is_err());
        assert!(parse(br#"{"type":"input","bootId":"b","paneId":"p","events":[{"Key":{"code":"Enter","modifiers":0,"kind":"Press","repeat_count":1,"tracks_release":false,"extra":1}}]}"#).is_err());
        for name in [
            "server.reload_config",
            "integration.install",
            "pane.run",
            "plugin.call",
            "pane.edit_scrollback",
            "pane.link.activate",
        ] {
            assert!(method(name).is_err(), "{name}");
        }
        assert!(method("pane.split").is_ok());
        assert!(
            validate_params(Method::TabCreate, &serde_json::json!({"command":"oops"})).is_err()
        );
    }
    #[test]
    fn clipboard_size_shape_and_schema_limits() {
        assert!(parse(br#"{"type":"clipboard-image","bootId":"b","target":{"Pane":"p"},"encoding":"base64","format":"png","data":"","unexpected":true}"#).is_err());
        assert!(parse(br#"{"type":"clipboard-image","bootId":"b","target":"DirectTerminal","encoding":"base64","format":"png","data":""}"#).is_err());
        assert!(
            png(
                "base64",
                "png",
                &"A".repeat(MAX_CLIPBOARD.div_ceil(3) * 4 + 1)
            )
            .is_err()
        );
        assert!(
            png(
                "base64",
                "png",
                &STANDARD.encode(vec![0; MAX_CLIPBOARD + 1])
            )
            .is_err()
        );
        assert!(png("base64", "jpg", "AA==").is_err());
        assert!(png("base64", "png", "@@==").is_err());
        assert!(geometry(512, 256, 0, 0).is_ok());
    }
    #[test]
    fn bounds_before_allocation_and_geometry() {
        let bytes = vec![b'x'; MAX_LINE + 1];
        assert!(read_line(&mut bytes.as_slice()).is_err());
        assert!(read_line(&mut b"partial".as_slice()).unwrap().is_none());
        assert_eq!(read_line(&mut b"{}\n".as_slice()).unwrap().unwrap(), b"{}");
        for (cols, rows) in [(0, 24), (513, 24), (512, 257), (80, 0)] {
            assert!(geometry(cols, rows, 0, 0).is_err());
        }
        assert!(geometry(256, 256, 4096, 4096).is_ok());
        assert!(geometry(80, 24, 4097, 0).is_err());
    }
}
