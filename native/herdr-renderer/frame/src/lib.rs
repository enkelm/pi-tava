//! Bounded presentation decoding. This reads render fields only, never input routing metadata.
use base64::{Engine, engine::general_purpose::STANDARD};
use herdr_protocol::{
    CellData, FrameData, SurfaceGraphicsAsset, SurfaceGraphicsAssetKey, SurfaceGraphicsFormat,
    SurfaceGraphicsPlacement, SurfaceGraphicsSource, SurfaceGraphicsTarget, SurfaceRect,
};
use serde::{Deserialize, Deserializer, de};
use std::{collections::HashSet, fmt, marker::PhantomData};

pub const MAX_PRESENTATION_BYTES: usize = 32 * 1024 * 1024;
const MAX_CELLS: usize = 512 * 256;
const MAX_IMAGES: usize = 128;
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_BASE64_BYTES: usize = MAX_IMAGE_BYTES.div_ceil(3) * 4;
const MAX_PLACEMENTS: usize = 4096;
const MAX_PANES: usize = 256;
const MAX_PIXELS: f32 = 16_000_000.;
pub const INVALID_PRESENTATION: &str = "Invalid terminal presentation.";

pub type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Debug)]
pub struct Theme {
    pub foreground: u32,
    pub background: u32,
    pub cursor: u32,
    pub bold: Option<u32>,
    pub palette: [u32; 256],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectionSpan {
    pub row: u16,
    pub columns: std::ops::Range<u16>,
}

fn valid_asset(key: &SurfaceGraphicsAssetKey, data: &[u8]) -> bool {
    if data.len() as u64 != key.data_len {
        return false;
    }
    let pixels = u64::from(key.image_width) * u64::from(key.image_height);
    match key.format {
        SurfaceGraphicsFormat::Rgb => pixels.checked_mul(3) == Some(key.data_len),
        SurfaceGraphicsFormat::Rgba => pixels.checked_mul(4) == Some(key.data_len),
        SurfaceGraphicsFormat::Png => true,
    }
}

/// Limits allocation during deserialization, not just after a Vec is constructed.
#[derive(Debug)]
struct BoundedVec<T, const N: usize>(Vec<T>);
impl<T, const N: usize> Default for BoundedVec<T, N> {
    fn default() -> Self {
        Self(Vec::new())
    }
}
impl<'de, T: Deserialize<'de>, const N: usize> Deserialize<'de> for BoundedVec<T, N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Visitor<T, const N: usize>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>, const N: usize> de::Visitor<'de> for Visitor<T, N> {
            type Value = BoundedVec<T, N>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a bounded array")
            }
            fn visit_seq<A: de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(N));
                while let Some(value) = seq.next_element()? {
                    if values.len() == N {
                        return Err(de::Error::custom("array limit"));
                    }
                    values.push(value);
                }
                Ok(BoundedVec(values))
            }
        }
        deserializer.deserialize_seq(Visitor::<T, N>(PhantomData))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Text<const N: usize>(String);
impl<'de, const N: usize> Deserialize<'de> for Text<N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Visitor<const N: usize>;
        impl<const N: usize> de::Visitor<'_> for Visitor<N> {
            type Value = Text<N>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a bounded string")
            }
            fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Self::Value, E> {
                if value.len() > N {
                    return Err(E::custom("string limit"));
                }
                Ok(Text(value.to_owned()))
            }
        }
        deserializer.deserialize_str(Visitor::<N>)
    }
}

/// Native output quotes integers above JS's safe range. Never round an image identity.
fn integer64<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    struct Visitor;
    impl de::Visitor<'_> for Visitor {
        type Value = u64;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("an unsigned integer or decimal identity")
        }
        fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<u64, E> {
            Ok(value)
        }
        fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<u64, E> {
            if value.is_empty() || value.len() > 20 || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(E::custom("invalid identity"));
            }
            value.parse().map_err(|_| E::custom("invalid identity"))
        }
    }
    d.deserialize_any(Visitor)
}

#[derive(Deserialize)]
struct Cell {
    symbol: Text<4096>,
    fg: u32,
    bg: u32,
    modifier: u16,
    #[serde(default)]
    skip: bool,
}
#[derive(Deserialize)]
struct Frame {
    width: u16,
    height: u16,
    cells: BoundedVec<Cell, MAX_CELLS>,
}
impl Frame {
    fn decode(self) -> Result<FrameData> {
        if !(1..=512).contains(&self.width)
            || !(1..=256).contains(&self.height)
            || self.cells.0.len() != usize::from(self.width) * usize::from(self.height)
            || self
                .cells
                .0
                .iter()
                .any(|cell| cell.symbol.0.encode_utf16().count() > 1024)
        {
            return Err(INVALID_PRESENTATION);
        }
        Ok(FrameData {
            width: self.width,
            height: self.height,
            cells: self
                .cells
                .0
                .into_iter()
                .map(|cell| CellData {
                    symbol: cell.symbol.0,
                    fg: cell.fg,
                    bg: cell.bg,
                    modifier: cell.modifier,
                    skip: cell.skip,
                    hyperlink: None,
                })
                .collect(),
            // The existing parent DOM owns cursor blinking, links and input.
            cursor: None,
            hyperlinks: Vec::new(),
            graphics: Vec::new(),
        })
    }
}

#[derive(Deserialize)]
struct WireTheme {
    foreground: u32,
    background: u32,
    cursor: u32,
    bold: Option<u32>,
    palette: BoundedVec<u32, 256>,
}
impl WireTheme {
    fn decode(self) -> Result<Theme> {
        if self.palette.0.len() != 256
            || [self.foreground, self.background, self.cursor]
                .into_iter()
                .chain(self.bold)
                .chain(self.palette.0.iter().copied())
                .any(|c| c > 0xffffff)
        {
            return Err(INVALID_PRESENTATION);
        }
        Ok(Theme {
            foreground: self.foreground,
            background: self.background,
            cursor: self.cursor,
            bold: self.bold,
            palette: self
                .palette
                .0
                .try_into()
                .map_err(|_| INVALID_PRESENTATION)?,
        })
    }
}

#[derive(Clone, Copy, Deserialize)]
pub struct Metrics {
    pub cw: f32,
    pub ch: f32,
    #[serde(rename = "fontSize")]
    pub font_size: f32,
}
impl Metrics {
    fn validate(self, frame: &FrameData) -> Result<Self> {
        let width = f32::from(frame.width) * self.cw;
        let height = f32::from(frame.height) * self.ch;
        if !self.cw.is_finite()
            || !self.ch.is_finite()
            || !self.font_size.is_finite()
            || !(1.0..=128.0).contains(&self.cw)
            || !(1.0..=192.0).contains(&self.ch)
            || !(6.0..=96.0).contains(&self.font_size)
            || width > 8192.
            || height > 8192.
            || width * height > MAX_PIXELS
        {
            return Err(INVALID_PRESENTATION);
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
pub struct Pane {
    pane_id: Text<256>,
    pub rect: SurfaceRect,
    pub inner_rect: SurfaceRect,
}
impl Pane {
    pub fn visible(&self, frame: &FrameData) -> Option<SurfaceRect> {
        intersect(intersect(frame_rect(frame), self.rect)?, self.inner_rect)
    }
}

#[derive(Deserialize)]
struct Popup {
    terminal_id: Text<256>,
    frame: Frame,
}
#[derive(Deserialize)]
struct Key {
    source: SurfaceGraphicsSource,
    image_width: u32,
    image_height: u32,
    format: SurfaceGraphicsFormat,
    #[serde(deserialize_with = "integer64")]
    data_len: u64,
    #[serde(deserialize_with = "integer64")]
    data_fingerprint: u64,
}
impl Key {
    fn decode(self) -> Result<SurfaceGraphicsAssetKey> {
        let ids_valid = match &self.source {
            SurfaceGraphicsSource::Terminal { target, .. } => match target {
                SurfaceGraphicsTarget::Pane { pane_id } => valid_id(pane_id),
                SurfaceGraphicsTarget::Popup { terminal_id } => valid_id(terminal_id),
            },
            SurfaceGraphicsSource::PaneLayer { pane_id, layer_id } => {
                valid_id(pane_id) && valid_id(layer_id)
            }
        };
        if !ids_valid
            || !(1..=10_000).contains(&self.image_width)
            || !(1..=10_000).contains(&self.image_height)
            || self.data_len == 0
            || self.data_len > MAX_IMAGE_BYTES as u64
        {
            return Err(INVALID_PRESENTATION);
        }
        Ok(SurfaceGraphicsAssetKey {
            source: self.source,
            image_width: self.image_width,
            image_height: self.image_height,
            format: self.format,
            data_len: self.data_len,
            data_fingerprint: self.data_fingerprint,
        })
    }
}

#[derive(Deserialize)]
struct Placement {
    asset: Key,
    logical_placement_id: u32,
    x: u16,
    y: u16,
    cols: u32,
    rows: u32,
    source_x: u32,
    source_y: u32,
    source_width: u32,
    source_height: u32,
    x_offset: u32,
    y_offset: u32,
    z: i32,
    scrollback_offset: u32,
}
impl Placement {
    fn decode(self) -> Result<SurfaceGraphicsPlacement> {
        let asset = self.asset.decode()?;
        if self.cols == 0
            || self.rows == 0
            || self.cols > 4096
            || self.rows > 4096
            || self.x > 4096
            || self.y > 4096
            || self.source_x >= asset.image_width
            || self.source_y >= asset.image_height
            || self.source_width > asset.image_width
            || self.source_height > asset.image_height
        {
            return Err(INVALID_PRESENTATION);
        }
        Ok(SurfaceGraphicsPlacement {
            asset,
            logical_placement_id: self.logical_placement_id,
            x: self.x,
            y: self.y,
            cols: self.cols,
            rows: self.rows,
            source_x: self.source_x,
            source_y: self.source_y,
            source_width: self.source_width,
            source_height: self.source_height,
            x_offset: self.x_offset,
            y_offset: self.y_offset,
            z: self.z,
            scrollback_offset: self.scrollback_offset,
        })
    }
}
#[derive(Default, Deserialize)]
struct Graphics {
    #[serde(default)]
    placements: BoundedVec<Placement, MAX_PLACEMENTS>,
}
#[derive(Deserialize)]
struct Image {
    key: Key,
    #[serde(deserialize_with = "integer64")]
    serial: u64,
    encoding: Text<16>,
    data: Text<MAX_BASE64_BYTES>,
}
#[derive(Deserialize)]
struct Surface {
    boot_id: Text<256>,
    frame: Frame,
    panes: BoundedVec<Pane, MAX_PANES>,
    popup: Option<Popup>,
    #[serde(default)]
    graphics: Graphics,
}
#[derive(Clone, Copy, Deserialize)]
struct Point {
    x: u16,
    y: u16,
}
#[derive(Deserialize)]
struct SelectionTarget {
    id: Text<256>,
    popup: bool,
    rect: SurfaceRect,
}
#[derive(Deserialize)]
struct Selection {
    boot: Text<256>,
    target: SelectionTarget,
    anchor: Point,
    head: Point,
}
#[derive(Deserialize)]
struct Envelope {
    surface: Surface,
    theme: WireTheme,
    metrics: Metrics,
    selection: Option<Selection>,
    images: BoundedVec<Image, MAX_IMAGES>,
}

pub struct LivePopup {
    pub id: String,
    pub frame: FrameData,
    pub highlights: Vec<SelectionSpan>,
}
pub struct Presentation {
    pub boot_id: String,
    pub frame: FrameData,
    pub panes: Vec<Pane>,
    pub popup: Option<LivePopup>,
    pub theme: Theme,
    pub metrics: Metrics,
    pub highlights: Vec<SelectionSpan>,
    pub placements: Vec<SurfaceGraphicsPlacement>,
    pub assets: Vec<SurfaceGraphicsAsset>,
    pub image_identities: Vec<(SurfaceGraphicsAssetKey, u64)>,
}

pub fn parse(serialized: &str) -> Result<Presentation> {
    if serialized.len() > MAX_PRESENTATION_BYTES {
        return Err(INVALID_PRESENTATION);
    }
    let envelope: Envelope = serde_json::from_str(serialized).map_err(|_| INVALID_PRESENTATION)?;
    let frame = envelope.surface.frame.decode()?;
    let metrics = envelope.metrics.validate(&frame)?;
    let theme = envelope.theme.decode()?;
    let panes = envelope.surface.panes.0;
    let mut ids = HashSet::new();
    for pane in &panes {
        if !valid_id(&pane.pane_id.0)
            || !valid_rect(pane.rect)
            || !valid_rect(pane.inner_rect)
            || !ids.insert(&pane.pane_id.0)
        {
            return Err(INVALID_PRESENTATION);
        }
    }
    let mut popup = envelope
        .surface
        .popup
        .map(|popup| {
            if !valid_id(&popup.terminal_id.0) {
                return Err(INVALID_PRESENTATION);
            }
            let popup_frame = popup.frame.decode()?;
            metrics.validate(&popup_frame)?;
            Ok(LivePopup {
                id: popup.terminal_id.0,
                frame: popup_frame,
                highlights: Vec::new(),
            })
        })
        .transpose()?;
    let mut placements = envelope
        .surface
        .graphics
        .placements
        .0
        .into_iter()
        .map(Placement::decode)
        .collect::<Result<Vec<_>>>()?;
    placements.sort_by_key(|placement| placement.z);
    let mut assets = Vec::new();
    let mut image_identities = Vec::new();
    let mut bytes = 0_usize;
    let mut decoded_bytes = 0_u64;
    let mut image_keys = HashSet::new();
    for image in envelope.images.0 {
        let key = image.key.decode()?;
        bytes = bytes
            .checked_add(key.data_len as usize)
            .ok_or(INVALID_PRESENTATION)?;
        decoded_bytes = decoded_bytes
            .checked_add(u64::from(key.image_width) * u64::from(key.image_height) * 4)
            .ok_or(INVALID_PRESENTATION)?;
        if bytes > MAX_IMAGE_BYTES
            || decoded_bytes > MAX_DECODED_IMAGE_BYTES
            || image.encoding.0 != "base64"
            || image.data.0.len() > (key.data_len as usize).div_ceil(3) * 4
            || !image_keys.insert(key.clone())
        {
            return Err(INVALID_PRESENTATION);
        }
        let data = STANDARD
            .decode(image.data.0)
            .map_err(|_| INVALID_PRESENTATION)?;
        if !valid_asset(&key, &data) {
            return Err(INVALID_PRESENTATION);
        }
        image_identities.push((key.clone(), image.serial));
        assets.push(SurfaceGraphicsAsset { key, data });
    }
    let mut highlights = Vec::new();
    if let Some(selection) = envelope.selection {
        if !valid_rect(selection.target.rect)
            || [
                selection.anchor.x,
                selection.anchor.y,
                selection.head.x,
                selection.head.y,
            ]
            .into_iter()
            .any(|n| n > 4096)
        {
            return Err(INVALID_PRESENTATION);
        }
        if selection.boot == envelope.surface.boot_id {
            if selection.target.popup {
                if let Some(popup) = popup
                    .as_mut()
                    .filter(|popup| popup.id == selection.target.id.0)
                {
                    popup.highlights = selection_spans(&selection, frame_rect(&popup.frame), true);
                }
            } else if let Some(clip) = panes
                .iter()
                .find(|pane| pane.pane_id == selection.target.id)
                .and_then(|pane| pane.visible(&frame))
            {
                highlights = selection_spans(&selection, clip, false);
            }
        }
    }
    Ok(Presentation {
        boot_id: envelope.surface.boot_id.0,
        frame,
        panes,
        popup,
        theme,
        metrics,
        highlights,
        placements,
        assets,
        image_identities,
    })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256
}
fn valid_rect(rect: SurfaceRect) -> bool {
    [rect.x, rect.y, rect.width, rect.height]
        .into_iter()
        .all(|n| n <= 4096)
}
pub fn frame_rect(frame: &FrameData) -> SurfaceRect {
    SurfaceRect {
        x: 0,
        y: 0,
        width: frame.width,
        height: frame.height,
    }
}
pub fn intersect(a: SurfaceRect, b: SurfaceRect) -> Option<SurfaceRect> {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    let right = (u32::from(a.x) + u32::from(a.width)).min(u32::from(b.x) + u32::from(b.width));
    let bottom = (u32::from(a.y) + u32::from(a.height)).min(u32::from(b.y) + u32::from(b.height));
    (right > u32::from(x) && bottom > u32::from(y)).then(|| SurfaceRect {
        x,
        y,
        width: (right - u32::from(x)) as u16,
        height: (bottom - u32::from(y)) as u16,
    })
}
fn selection_spans(selection: &Selection, clip: SurfaceRect, popup: bool) -> Vec<SelectionSpan> {
    let (mut a, mut b) = (selection.anchor, selection.head);
    if (a.y, a.x) > (b.y, b.x) {
        std::mem::swap(&mut a, &mut b);
    }
    let rect = selection.target.rect;
    let row_start = if popup { 0 } else { rect.x };
    let row_end = u32::from(row_start) + u32::from(rect.width);
    let top = a.y.max(clip.y);
    let bottom = b.y.min(clip.y + clip.height - 1);
    (top..=bottom)
        .filter_map(|row| {
            let start = (if row == a.y { a.x } else { row_start }).max(clip.x);
            let end = (if row == b.y {
                u32::from(b.x) + 1
            } else {
                row_end
            })
            .min(u32::from(clip.x) + u32::from(clip.width));
            (u32::from(start) < end).then_some(SelectionSpan {
                row,
                columns: start..end as u16,
            })
        })
        .collect()
}

/// Split at the same pane/content edges as Canvas2D. Each run's text and graphics are masked,
/// so a wide glyph cannot overpaint a divider or a neighbouring pane.
pub fn row_runs(frame: &FrameData, panes: &[Pane], row: u16) -> Vec<std::ops::Range<u16>> {
    let mut edges = vec![0, frame.width];
    for pane in panes {
        for rect in [intersect(frame_rect(frame), pane.rect), pane.visible(frame)]
            .into_iter()
            .flatten()
        {
            if row >= rect.y && row < rect.y + rect.height {
                edges.extend([rect.x, rect.x + rect.width]);
            }
        }
    }
    edges.sort_unstable();
    edges.dedup();
    edges.windows(2).map(|pair| pair[0]..pair[1]).collect()
}

pub fn placement_clip(
    presentation: &Presentation,
    placement: &SurfaceGraphicsPlacement,
) -> Option<SurfaceRect> {
    let pane_id = match &placement.asset.source {
        SurfaceGraphicsSource::Terminal {
            target: SurfaceGraphicsTarget::Pane { pane_id },
            ..
        }
        | SurfaceGraphicsSource::PaneLayer { pane_id, .. } => pane_id,
        _ => return None,
    };
    presentation
        .panes
        .iter()
        .find(|pane| pane.pane_id.0 == *pane_id)?
        .visible(&presentation.frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn presentation() -> Value {
        json!({
            "surface": {
                "boot_id": "boot", "projection_revision": "18446744073709551615",
                "frame": {"width": 3, "height": 2,
                    "cells": (0..6).map(|_| json!({"symbol":"界", "fg":0, "bg":0, "modifier":0, "skip":false})).collect::<Vec<_>>(),
                    "cursor": {"x":1,"y":1,"visible":true}},
                "panes": [{"pane_id":"p","rect":{"x":0,"y":0,"width":3,"height":2},
                    "inner_rect":{"x":1,"y":0,"width":2,"height":2}}],
                "popup":null, "graphics":{"placements":[]}},
            "metrics":{"cw":7.8,"ch":20,"fontSize":13},
            "theme":{"foreground":0xd8dee9,"background":0x101419,"cursor":0xd8dee9,"bold":null,"palette":vec![0;256]},
            "selection":{"boot":"boot","target":{"id":"p","popup":false,"rect":{"x":0,"y":0,"width":3,"height":2}},
                "anchor":{"x":2,"y":1},"head":{"x":0,"y":0}},
            "images":[]
        })
    }

    fn image() -> Value {
        json!({
            "key": {"source":{"Terminal":{"target":{"Pane":{"pane_id":"p"}},"image_id":1}},
                "image_width":1,"image_height":1,"format":"Rgba","data_len":4,
                "data_fingerprint":"18446744073709551615"},
            "serial":"18446744073709551614","encoding":"base64","data":"AQIDBA=="
        })
    }

    #[test]
    fn live_render_fields_preserve_metrics_unicode_and_clipped_reversed_selection() {
        let parsed = parse(&presentation().to_string()).unwrap();
        assert_eq!(
            (
                parsed.metrics.cw,
                parsed.metrics.ch,
                parsed.metrics.font_size
            ),
            (7.8, 20., 13.)
        );
        assert!(parsed.frame.cursor.is_none());
        assert_eq!(parsed.frame.cells[0].symbol, "界");
        assert_eq!(
            parsed.highlights,
            vec![
                SelectionSpan {
                    row: 0,
                    columns: 1..3
                },
                SelectionSpan {
                    row: 1,
                    columns: 1..3
                },
            ]
        );
        assert_eq!(row_runs(&parsed.frame, &parsed.panes, 0), vec![0..1, 1..3]);
    }

    #[test]
    fn rejects_malformed_cells_geometry_and_appearance_with_redacted_errors() {
        let baseline = presentation();
        for (pointer, replacement) in [
            ("/surface/frame/width", json!(513)),
            ("/surface/frame/width", json!(0)),
            ("/surface/frame/height", json!(257)),
            ("/surface/frame/cells/5/modifier", json!(65536)),
            ("/surface/frame/cells/5/fg", json!(-1)),
            (
                "/surface/frame/cells/5/symbol",
                json!("secret".repeat(1025)),
            ),
            ("/surface/frame/cells", json!([])),
            ("/metrics/cw", json!(0)),
            ("/metrics/cw", json!("NaN")),
            ("/metrics/ch", json!(null)),
            ("/metrics/fontSize", json!(200)),
            ("/theme/palette", json!([0, 1])),
            ("/theme/background", json!(0x1000000)),
        ] {
            let mut value = baseline.clone();
            *value.pointer_mut(pointer).unwrap() = replacement;
            assert_eq!(
                parse(&value.to_string()).err(),
                Some(INVALID_PRESENTATION),
                "{pointer}"
            );
        }
        assert_eq!(parse("").err(), Some(INVALID_PRESENTATION));
        assert_eq!(parse("null").err(), Some(INVALID_PRESENTATION));
        assert_eq!(parse("{secret").err(), Some(INVALID_PRESENTATION));
    }

    #[test]
    fn bounds_full_grid_and_payload_before_accepting() {
        let mut value = presentation();
        value["surface"]["frame"]["width"] = json!(512);
        value["surface"]["frame"]["height"] = json!(256);
        value["metrics"]["cw"] = json!(6);
        value["surface"]["frame"]["cells"] = json!(vec![
            value["surface"]["frame"]["cells"][0]
                .clone();
            MAX_CELLS
        ]);
        let decoded = parse(&value.to_string()).unwrap();
        assert_eq!(decoded.frame.cells.len(), MAX_CELLS);
        // Each side fits 8192px, but total CSS pixel work must remain bounded.
        value["metrics"]["cw"] = json!(16);
        value["metrics"]["ch"] = json!(32);
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID_PRESENTATION));
        value["surface"]["frame"]["cells"]
            .as_array_mut()
            .unwrap()
            .push(json!({"symbol":"extra","fg":0,"bg":0,"modifier":0}));
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID_PRESENTATION));
        assert_eq!(
            parse(&" ".repeat(MAX_PRESENTATION_BYTES + 1)).err(),
            Some(INVALID_PRESENTATION)
        );
    }

    #[test]
    fn exact_image_identities_and_bytes_are_not_rounded_or_interpreted_as_urls() {
        let mut value = presentation();
        value["images"] = json!([image()]);
        let parsed = parse(&value.to_string()).unwrap();
        assert_eq!(parsed.assets[0].data, vec![1, 2, 3, 4]);
        assert_eq!(parsed.assets[0].key.data_fingerprint, u64::MAX);
        assert_eq!(parsed.image_identities[0].1, u64::MAX - 1);
        for (pointer, replacement) in [
            ("/images/0/encoding", json!("url")),
            ("/images/0/data", json!("https://private.invalid/image")),
            ("/images/0/data", json!("AQID")),
            (
                "/images/0/key/data_fingerprint",
                json!("18446744073709551616"),
            ),
            ("/images/0/key/image_width", json!(10001)),
            ("/images/0/key/data_len", json!(MAX_IMAGE_BYTES + 1)),
        ] {
            let mut invalid = value.clone();
            *invalid.pointer_mut(pointer).unwrap() = replacement;
            assert_eq!(
                parse(&invalid.to_string()).err(),
                Some(INVALID_PRESENTATION),
                "{pointer}"
            );
        }
        value["images"] = json!([image(), image()]);
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID_PRESENTATION));
        value["images"] = json!(vec![image(); 129]);
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID_PRESENTATION));
    }

    #[test]
    fn image_metadata_cannot_expand_beyond_the_browser_decode_budget() {
        let mut value = presentation();
        let mut compressed = image();
        // Encoded PNG data is opaque here; its metadata must be bounded before decoding.
        compressed["key"]["format"] = json!("Png");
        compressed["key"]["image_width"] = json!(4096);
        compressed["key"]["image_height"] = json!(4096);
        value["images"] = json!([compressed.clone()]);
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID_PRESENTATION));
        compressed["key"]["image_width"] = json!(2048);
        compressed["key"]["image_height"] = json!(2048);
        let assets: Vec<_> = (1..=3)
            .map(|id| {
                let mut asset = compressed.clone();
                asset["key"]["source"]["Terminal"]["image_id"] = json!(id);
                asset
            })
            .collect();
        value["images"] = json!(assets[..2]);
        assert!(parse(&value.to_string()).is_ok());
        value["images"] = json!(assets);
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID_PRESENTATION));
    }

    #[test]
    fn popup_selection_is_local_and_old_boot_selection_is_absent() {
        let mut value = presentation();
        value["surface"]["popup"] =
            json!({"terminal_id":"popup", "frame":value["surface"]["frame"]});
        value["selection"]["target"]["id"] = json!("popup");
        value["selection"]["target"]["popup"] = json!(true);
        let decoded = parse(&value.to_string()).unwrap();
        assert!(decoded.highlights.is_empty());
        assert_eq!(
            decoded.popup.unwrap().highlights,
            vec![
                SelectionSpan {
                    row: 0,
                    columns: 0..3
                },
                SelectionSpan {
                    row: 1,
                    columns: 0..3
                },
            ]
        );
        value["selection"]["boot"] = json!("old boot");
        assert!(
            parse(&value.to_string())
                .unwrap()
                .popup
                .unwrap()
                .highlights
                .is_empty()
        );
        value["surface"]["popup"]["frame"]["cells"][5]["bg"] = json!(4294967296_u64);
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID_PRESENTATION));
    }

    #[test]
    fn images_are_clipped_to_their_target_pane_content() {
        let mut value = presentation();
        let placement = json!({"asset":image()["key"],"logical_placement_id":1,
            "x":0,"y":0,"cols":3,"rows":2,"source_x":0,"source_y":0,"source_width":0,"source_height":0,
            "x_offset":0,"y_offset":0,"z":-1,"scrollback_offset":0});
        value["surface"]["graphics"]["placements"] = json!([placement]);
        let decoded = parse(&value.to_string()).unwrap();
        assert_eq!(
            placement_clip(&decoded, &decoded.placements[0]),
            Some(SurfaceRect {
                x: 1,
                y: 0,
                width: 2,
                height: 2
            })
        );
        value["surface"]["graphics"]["placements"][0]["asset"]["source"]["Terminal"]["target"]["Pane"]
            ["pane_id"] = json!("missing");
        let decoded = parse(&value.to_string()).unwrap();
        assert!(placement_clip(&decoded, &decoded.placements[0]).is_none());
        value["surface"]["graphics"]["placements"] = json!(vec![
                value["surface"]["graphics"]["placements"][0].clone();
                4097
            ]);
        assert_eq!(parse(&value.to_string()).err(), Some(INVALID_PRESENTATION));
    }
}
