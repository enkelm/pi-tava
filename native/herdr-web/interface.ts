/** JSONL contract v1. See README.md for ordering, limits, and trust requirements.
 * Nested protocol fields/enums are the pinned herdr-protocol Serde JSON model.
 * Adapted type declarations: Apache-2.0, see NOTICE.md and LICENSE-APACHE.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Integers outside JS's safe range are decimal strings. Never round image keys. */
export type Integer = number | string;
export type Color = { r: number; g: number; b: number };
export type KeyCode =
    | "Backspace"
    | "Enter"
    | "Left"
    | "Right"
    | "Up"
    | "Down"
    | "Home"
    | "End"
    | "PageUp"
    | "PageDown"
    | "Tab"
    | "BackTab"
    | "Delete"
    | "Insert"
    | "Esc"
    | "Null"
    | { Char: string }
    | { F: number };
export type MouseButton = "Left" | "Right" | "Middle";
export type MouseKind =
    | { Down: MouseButton }
    | { Up: MouseButton }
    | { Drag: MouseButton }
    | "Moved"
    | "ScrollUp"
    | "ScrollDown"
    | "ScrollLeft"
    | "ScrollRight";
export type InputEvent =
    | { TextCommit: string }
    | { Paste: string }
    | {
          Key: {
              code: KeyCode;
              /** Shift=1, Control=2, Alt=4, Super=8, Hyper=16, Meta=32. */
              modifiers: number;
              kind: "Press" | "Repeat" | "Release";
              repeat_count: number;
              shifted_codepoint: number | null;
              generated_text: string | null;
              tracks_release: boolean;
              physical_key_id: number | null;
              windows_record: null | {
                  key_down: boolean;
                  repeat_count: number;
                  virtual_key_code: number;
                  virtual_scan_code: number;
                  unicode: number;
                  control_key_state: number;
              };
          };
      }
    | {
          Mouse: {
              kind: MouseKind;
              position:
                  | { Cell: { column: number; row: number } }
                  | { Pixels: { x: number; y: number; column: number; row: number } };
              geometry: null | { cols: number; rows: number; width_px: number; height_px: number };
              modifiers: number;
              lines: number;
          };
      };

/** Closed allowlist. The pinned client additionally checks welcome.methods. */
export type Method =
    | "command.invoke"
    | "client_shell.surface.set"
    | "layout.set_split_ratio"
    | "pane.clear"
    | "pane.close"
    | "pane.copy_motion"
    | "pane.copy_search"
    | "pane.focus"
    | "pane.focus_direction"
    | "pane.input.set"
    | "pane.link.resolve"
    | "pane.rename"
    | "pane.resize"
    | "pane.scroll"
    | "pane.selection.read"
    | "pane.split"
    | "pane.swap"
    | "pane.zoom"
    | "product_announcement.dismiss"
    | "release_notes.dismiss"
    | "tab.close"
    | "tab.create"
    | "tab.focus"
    | "tab.move"
    | "tab.rename"
    | "workspace.close"
    | "workspace.create"
    | "workspace.focus"
    | "workspace.move_block"
    | "workspace.rename"
    | "worktree.create"
    | "worktree.list"
    | "worktree.open"
    | "worktree.remove";

export type Input =
    | { type: "input"; bootId: string; paneId: string; events: InputEvent[] }
    | { type: "popup-input"; bootId: string; terminalId: string; events: InputEvent[] }
    | {
          type: "clipboard-image";
          bootId: string;
          target: { Pane: string } | { Popup: string };
          encoding: "base64";
          format: "png";
          data: string;
      }
    | {
          type: "resize";
          bootId: string;
          cols: number;
          rows: number;
          cellWidth: number;
          cellHeight: number;
      }
    | {
          type: "request";
          bootId: string;
          method: Method;
          params: { [key: string]: Json };
          requestId: string;
      }
    | { type: "focus"; bootId: string; focused: boolean }
    | {
          type: "theme";
          bootId: string;
          theme: {
              foreground: Color;
              background: Color;
              palette: Color[];
              appearance: "Dark" | "Light";
          };
      }
    | { type: "close" };

export type Rect = { x: number; y: number; width: number; height: number };
export type Cell = {
    symbol: string;
    fg: number;
    bg: number;
    modifier: number;
    skip: boolean;
    hyperlink: number | null;
};
export type Cursor = { x: number; y: number; visible: boolean; shape: number };
export type Frame = {
    width: number;
    height: number;
    cells: Cell[];
    cursor: Cursor | null;
    hyperlinks: string[];
    graphics: number[];
};
export type AssetKey = {
    source:
        | {
              Terminal: {
                  target: { Pane: { pane_id: string } } | { Popup: { terminal_id: string } };
                  image_id: number;
              };
          }
        | { PaneLayer: { pane_id: string; layer_id: string } };
    image_width: number;
    image_height: number;
    format: "Rgb" | "Rgba" | "Png";
    data_len: Integer;
    data_fingerprint: Integer;
};
export type Placement = {
    asset: AssetKey;
    logical_placement_id: number;
    x: number;
    y: number;
    cols: number;
    rows: number;
    source_x: number;
    source_y: number;
    source_width: number;
    source_height: number;
    x_offset: number;
    y_offset: number;
    z: number;
    scrollback_offset: number;
};
export type Surface = {
    boot_id: string;
    projection_revision: Integer;
    surface_revision: Integer;
    frame: Frame;
    panes: {
        pane_id: string;
        content_revision: Integer;
        rect: Rect;
        inner_rect: Rect;
        scrollbar_rect: Rect | null;
        scroll: null | {
            offset_from_bottom: Integer;
            max_offset_from_bottom: Integer;
            viewport_rows: Integer;
        };
        focused: boolean;
        mouse_reporting: boolean;
        sgr_pixel_mouse: boolean;
        alternate_screen_active: boolean;
        pixel_width: number;
        pixel_height: number;
    }[];
    splits: {
        direction: "Horizontal" | "Vertical";
        pos: number;
        area: Rect;
        hit_rect: Rect;
        path: boolean[];
    }[];
    popup: null | {
        terminal_id: string;
        title: string;
        width: { Cells: number } | { Percent: number } | null;
        height: { Cells: number } | { Percent: number } | null;
        frame: Frame;
        mouse_reporting: boolean;
        sgr_pixel_mouse: boolean;
        pixel_width: number;
        pixel_height: number;
    };
    /** Client removes pixel bytes from assets; use the preceding images event. */
    graphics: { assets: []; placements: Placement[]; retained_assets: AssetKey[] };
};
export type Image = { key: AssetKey; serial: Integer; encoding: "base64"; data: string };
export type Welcome = {
    generation: number;
    server_version: string;
    snapshot_codec: string;
    surface_codec: string;
    input_codec: string;
    blob_codec: string;
    methods: string[];
    capabilities: string[];
    error?: { code: string; message: string };
};
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type Worktree = { key: string; label: string; is_linked_worktree: boolean };
export type Workspace = {
    workspace_id: string;
    active_tab_id: string;
    new_workspace_cwd: string;
    number: Integer;
    label: string;
    custom_label: boolean;
    branch: string | null;
    git_ahead_behind: [Integer, Integer] | null;
    tokens: [string, string][];
    worktree: Worktree | null;
    focused: boolean;
    agent_status: AgentStatus;
};
export type Tab = {
    tab_id: string;
    workspace_id: string;
    number: Integer;
    label: string;
    custom_label: boolean;
    zoomed: boolean;
    focused: boolean;
    agent_status: AgentStatus;
};
export type Pane = {
    pane_id: string;
    workspace_id: string;
    tab_id: string;
    label: string | null;
    cwd: string | null;
    foreground_cwd: string | null;
    focused: boolean;
    right_click_passthrough: boolean;
};
export type Agent = {
    pane_id: string;
    workspace_id: string;
    tab_id: string;
    name: string | null;
    display_agent: string | null;
    agent: string | null;
    title: string | null;
    terminal_title: string | null;
    terminal_title_stripped: string | null;
    agent_status: AgentStatus;
    state_change_seq: Integer;
    state_labels: [string, string][];
    tokens: [string, string][];
    focused: boolean;
};
/** Full, unfiltered upstream ClientShellSnapshot JSON. No field is omitted. */
export type Snapshot = {
    boot_id: string;
    revision: Integer;
    config_diagnostic: string | null;
    product_announcement: null | {
        version: string;
        id: string;
        title: string;
        body: string;
        preview: boolean;
    };
    update_available: string | null;
    update_install_command: string;
    server_keybindings_toml: string | null;
    latest_release_notes_available: boolean;
    integration_updates_available: boolean;
    worktree_directory: string;
    release_notes: null | { version: string; body: string; preview: boolean };
    focused_workspace_id: string | null;
    focused_tab_id: string | null;
    focused_pane_id: string | null;
    tab_bar_right: { text: string; accent: boolean }[];
    tab_bar_right_separator: string;
    agent_view_label: string | null;
    agent_order: string[];
    workspaces: Workspace[];
    tabs: Tab[];
    panes: Pane[];
    agents: Agent[];
    commands: {
        command_id: string;
        binding_label: string;
        binding_labels: string[];
        action: "Shell" | "Pane" | "Popup" | "PluginAction" | "Unknown";
        description: string | null;
    }[];
};
/** Full upstream ServerMessage, externally tagged. Includes clipboard/title/bell,
 * keyboard/mouse modes, notifications, graphics, shutdown and endpoint controls.
 * For example { Clipboard: { data: "..." } } or { TerminalBell: { count: 1 } }.
 * Unit variants are strings, e.g. "ReloadSoundConfig". Never read GraphicsFile.path.
 */
export type SemanticNotification = {
    kind: "NeedsAttention" | "Finished" | "UpdateInstalled" | "Custom";
    title: string;
    body: string | null;
    sound: "Done" | "Request" | null;
    agent: string | null;
    workspace_id: string | null;
    tab_id: string | null;
    pane_id: string | null;
    position: "top-left" | "top-right" | "bottom-left" | "bottom-right" | null;
};
export type SurfacePatch = {
    boot_id: string;
    projection_revision: Integer;
    base_surface_revision: Integer;
    surface_revision: Integer;
    rows: { x: number; y: number; cells: Cell[] }[];
    panes: Surface["panes"];
    cursor: Cursor | null;
};
export type Message =
    | {
          Welcome: {
              version: number;
              encoding: "SemanticFrame" | "TerminalAnsi";
              error: string | null;
          };
      }
    | { Terminal: { seq: Integer; width: number; height: number; full: boolean; bytes: number[] } }
    | { Graphics: { bytes: number[] } }
    | { ServerShutdown: { reason: string | null } }
    | { Notify: { kind: "Sound" | "Toast" | "SystemToast"; message: string; body: string | null } }
    | { Clipboard: { data: string } }
    | { WindowTitle: { title: string | null } }
    | "ReloadSoundConfig"
    | { MouseCapture: { enabled: boolean; sgr_pixels: boolean } }
    | { TerminalBell: { count: number } }
    | {
          GraphicsFile: {
              path: string;
              expected_len: Integer;
              image_id: number;
              transfer_id: Integer;
              leading: number[];
              control: string;
              surface_asset: AssetKey | null;
          };
      }
    | { GraphicsTransmissionRetired: { transfer_id: Integer; image_id: number } }
    | { ClientShellSnapshot: Snapshot }
    | {
          PaneSurface: Omit<Surface, "graphics"> & {
              graphics: {
                  assets: { key: AssetKey; data: number[] }[];
                  placements: Placement[];
                  retained_assets: AssetKey[];
              };
          };
      }
    | { SemanticNotification: SemanticNotification }
    | { ClientShellError: { message: string } }
    | { DirectTerminalKeyboardProtocol: { flags: number; modify_other_keys_level: number } }
    | { ClientShellKeyboardReportAll: { enabled: boolean } }
    | {
          ClientShellEndpointResponseChunk: {
              boot_id: string;
              request_id: string;
              final_chunk: boolean;
              data: number[];
          };
      }
    | { PaneSurfacePatch: SurfacePatch }
    | { EndpointControl: { kind: string; data: string } };
export type Output =
    | { type: "connected"; welcome: Welcome }
    | { type: "snapshot"; snapshot: Snapshot }
    | { type: "surface"; surface: Surface }
    /** Replaces the previous image set. Sent before surfaces needing these bytes. */
    | { type: "images"; images: Image[] }
    | { type: "message"; message: Message }
    /** requestId is the caller ID; response is the unchanged Herdr API envelope. */
    | { type: "response"; requestId: string; response: Json }
    | { type: "rejected"; requestId?: string; reason: string }
    | { type: "closed"; reason: string };
