// Adapted from Herdr GPUI e370bf0a55b1bf3e7e7fcb5b3f130ebc1a9e68bf.
// Copyright 2026 Fabien Penso. Apache-2.0; see LICENSE-APACHE and UPSTREAM.md.
use crate::config::Theme;
use crate::protocol::{CellData, CursorState, PaneSurfacePane, SurfaceRect};
use gpui::{Bounds, Pixels, Point, point, px, size};

pub const FONT_SIZE: f32 = 14.;
pub const CELL_HEIGHT: f32 = 20.;

pub(crate) const BOLD: u16 = 1;
pub(crate) const DIM: u16 = 1 << 1;
pub(crate) const ITALIC: u16 = 1 << 2;
pub(crate) const UNDERLINE: u16 = 1 << 3;
pub(crate) const REVERSED: u16 = 1 << 6;
pub(crate) const HIDDEN: u16 = 1 << 7;
pub(crate) const STRIKETHROUGH: u16 = 1 << 8;

pub(crate) fn cursor_offset(
    cursor: &CursorState,
    cell_width: f32,
    cell_height: f32,
) -> Point<Pixels> {
    point(
        px(cursor.x as f32 * cell_width),
        px(cursor.y as f32 * cell_height),
    )
}

pub fn color(value: u32, default: u32, theme: &Theme) -> u32 {
    match value >> 24 {
        0 => match value & 255 {
            1..=16 => theme.palette[((value & 255) - 1) as usize],
            _ => default,
        },
        1 => theme.palette[(value & 255) as usize],
        2 => value & 0xffffff,
        _ => default,
    }
}

fn is_default(value: u32) -> bool {
    match value >> 24 {
        0 => !(1..=16).contains(&(value & 255)),
        1 | 2 => false,
        _ => true,
    }
}

pub fn cell_colors(cell: &CellData, theme: &Theme) -> (u32, u32) {
    let mut fg = match theme.bold {
        Some(bold) if cell.modifier & BOLD != 0 && is_default(cell.fg) => bold,
        _ => color(cell.fg, theme.foreground, theme),
    };
    let mut bg = color(cell.bg, theme.background, theme);
    if cell.modifier & REVERSED != 0 {
        std::mem::swap(&mut fg, &mut bg);
    }
    if cell.modifier & DIM != 0 {
        fg = ((fg & 0xfefefe) >> 1) + ((bg & 0xfefefe) >> 1);
    }
    if cell.modifier & HIDDEN != 0 {
        fg = bg;
    }
    (fg, bg)
}

const MIN_THUMB: f32 = 24.;

/// A pane's scrollbar in grid pixels. The daemon draws it as cells, which
/// move the thumb a whole row per many lines; this places it to the pixel.
/// Painting and dragging share it so the thumb is where it is grabbed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Scrollbar {
    pub track: Bounds<Pixels>,
    pub thumb: Bounds<Pixels>,
    max: u64,
}

impl Scrollbar {
    pub(crate) fn new(pane: &PaneSurfacePane, cell_width: f32, cell_height: f32) -> Option<Self> {
        let (rect, scroll) = (pane.scrollbar_rect?, pane.scroll?);
        if scroll.max_offset_from_bottom == 0 || rect.height == 0 {
            return None;
        }
        let track = Bounds::new(
            point(
                px(f32::from(rect.x) * cell_width),
                px(f32::from(rect.y) * cell_height),
            ),
            size(
                px(f32::from(rect.width) * cell_width),
                px(f32::from(rect.height) * cell_height),
            ),
        );
        let height = f32::from(track.size.height);
        let max = scroll.max_offset_from_bottom as f32;
        let visible = scroll.viewport_rows as f32;
        let thumb = (height * visible / (max + visible))
            .max(MIN_THUMB)
            .min(height);
        let offset = scroll.offset_from_bottom.min(scroll.max_offset_from_bottom) as f32;
        let top = (height - thumb) * (1. - offset / max);
        Some(Self {
            track,
            thumb: Bounds::new(
                track.origin + point(px(0.), px(top)),
                size(track.size.width, px(thumb)),
            ),
            max: scroll.max_offset_from_bottom,
        })
    }

    /// The offset from the bottom that puts the thumb's top at `top`.
    pub(crate) fn offset_at(&self, top: f32) -> u64 {
        let travel = f32::from(self.track.size.height - self.thumb.size.height);
        if travel <= 0. {
            return 0;
        }
        let fraction = ((top - f32::from(self.track.top())) / travel).clamp(0., 1.);
        ((1. - fraction) * self.max as f32).round() as u64
    }
}

pub(crate) fn in_rect(rect: SurfaceRect, x: u16, y: u16) -> bool {
    x >= rect.x
        && y >= rect.y
        && u32::from(x) < u32::from(rect.x) + u32::from(rect.width)
        && u32::from(y) < u32::from(rect.y) + u32::from(rect.height)
}
