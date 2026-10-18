//! A GPUI scene for the current complete parent presentation. No fixtures or input state.
#[path = "live.rs"]
mod live;

use crate::SurfaceImages;
use crate::config::Theme;
use crate::protocol::SurfaceRect;
use crate::upstream::terminal_painter::{
    Highlight, ImageTarget, Layer, Part, PlacedImages, Span, TerminalPainter, Tint,
};
use gpui::{
    App, Bounds, ContentMask, Font, Pixels, Point, Window, fill, point, px, rgb, rgba, size,
};
use live::{Metrics, Presentation, SelectionSpan};
use std::{collections::HashMap, rc::Rc};

struct Region {
    rect: SurfaceRect,
    area: Vec<Span>,
}

pub(crate) struct Scene {
    painter: TerminalPainter,
    font: Font,
    presentation: Option<Rc<Presentation>>,
    images: SurfaceImages,
    regions: Vec<Region>,
    highlights: Vec<Highlight>,
    popup_highlights: Vec<Highlight>,
    sequence: u32,
    needs_image_clear: bool,
}

impl Scene {
    pub(crate) fn new(family: String) -> Self {
        Self {
            painter: TerminalPainter::default(),
            font: gpui::font(family),
            presentation: None,
            images: SurfaceImages::default(),
            regions: Vec::new(),
            highlights: Vec::new(),
            popup_highlights: Vec::new(),
            sequence: 0,
            needs_image_clear: false,
        }
    }

    pub(crate) fn present(&mut self, serialized: &str, sequence: u32) -> Result<(), &'static str> {
        if sequence == 0 {
            return Err(live::INVALID_PRESENTATION);
        }
        let mut next = live::parse(serialized)?;
        if self
            .presentation
            .as_ref()
            .is_some_and(|previous| previous.boot_id != next.boot_id)
        {
            self.clear(0);
        }
        let mut theme = Theme::default();
        theme.background = next.theme.background;
        theme.foreground = next.theme.foreground;
        theme.cursor = next.theme.cursor;
        theme.bold = next.theme.bold;
        theme.palette = next.theme.palette;
        self.painter
            .set_appearance(next.metrics.font_size, next.metrics.ch, theme);
        self.images
            .replace_live(std::mem::take(&mut next.assets), &next.image_identities);
        self.regions = regions(&next);
        self.highlights = highlights(&next.highlights);
        self.popup_highlights = next
            .popup
            .as_ref()
            .map_or_else(Vec::new, |popup| highlights(&popup.highlights));
        self.presentation = Some(Rc::new(next));
        self.sequence = sequence;
        Ok(())
    }

    pub(crate) fn clear(&mut self, sequence: u32) {
        self.presentation = None;
        self.images = SurfaceImages::default();
        self.regions.clear();
        self.highlights.clear();
        self.popup_highlights.clear();
        self.sequence = sequence;
        self.needs_image_clear = true;
    }

    /// Returns a receipt only after the new content's GPUI paint callback completes.
    /// This is CPU scene construction, not a GPU/display-completion fence.
    pub(crate) fn paint(
        &mut self,
        bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<u32> {
        if self.needs_image_clear {
            // Clear the old GPU cache before drawing or acknowledging this fence.
            // Encoded assets accepted after clear belong to the next frame and stay intact.
            self.painter.clear_images(window);
            self.needs_image_clear = false;
        }
        if let Some(presentation) = self.presentation.as_ref() {
            let width = f32::from(presentation.frame.width) * presentation.metrics.cw;
            let height = f32::from(presentation.frame.height) * presentation.metrics.ch;
            if (f32::from(bounds.size.width) - width).abs() > 1.
                || (f32::from(bounds.size.height) - height).abs() > 1.
            {
                // ResizeObserver can trail presentation admission. Do not acknowledge a
                // stretched/cropped old viewport. A real resize redraws; a hardware size
                // clamp eventually hits the parent's deadline and fails the renderer closed.
                return None;
            }
        }
        let background = self
            .presentation
            .as_ref()
            .map_or(0x101419, |p| p.theme.background);
        let presentation = self.presentation.clone();
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            window.paint_quad(fill(bounds, rgb(background)));
            let Some(presentation) = presentation.as_ref() else {
                self.painter.release_idle_images(window);
                return;
            };
            let metrics = presentation.metrics;
            let root = pixel_rect(
                live::frame_rect(&presentation.frame),
                bounds.origin,
                metrics,
            );
            window.with_content_mask(
                Some(ContentMask {
                    bounds: root.intersect(&bounds),
                }),
                |window| {
                    // Every region's backgrounds precede every region's text; images retain
                    // Kitty's below/above-text ordering and their owning pane's content mask.
                    self.paint_regions(Layer::Backgrounds, bounds.origin, window, cx);
                    self.paint_images(false, false, bounds.origin, window, cx);
                    self.paint_regions(Layer::Text, bounds.origin, window, cx);
                    self.paint_regions(Layer::Decorations, bounds.origin, window, cx);
                    self.paint_images(true, false, bounds.origin, window, cx);
                    let Some(popup) = presentation.popup.as_ref() else {
                        return;
                    };
                    window.paint_quad(fill(root, rgba(0x00000059)));
                    let scale = window.scale_factor();
                    let centered = |available: Pixels, cells: u16, cell: f32| {
                        let offset =
                            ((f32::from(available) - f32::from(cells) * cell).max(0.)) / 2.;
                        px((offset * scale).round() / scale)
                    };
                    let origin = bounds.origin
                        + point(
                            centered(root.size.width, popup.frame.width, metrics.cw),
                            centered(root.size.height, popup.frame.height, metrics.ch),
                        );
                    let popup_bounds = pixel_rect(live::frame_rect(&popup.frame), origin, metrics)
                        .intersect(&root);
                    // The complete popup is clipped as one native frame. Its images are still
                    // separate passes, so their z order cannot bypass backgrounds or text.
                    window.with_content_mask(
                        Some(ContentMask {
                            bounds: popup_bounds,
                        }),
                        |window| {
                            let all: Vec<_> = (0..popup.frame.height)
                                .map(|row| Span {
                                    row,
                                    columns: 0..popup.frame.width,
                                })
                                .collect();
                            self.painter.paint_frame(
                                &popup.frame,
                                origin,
                                None,
                                metrics.cw,
                                &self.font,
                                &self.popup_highlights,
                                &[],
                                Some(Part {
                                    area: &all,
                                    layer: Layer::Backgrounds,
                                }),
                                None,
                                window,
                                cx,
                            );
                            self.paint_images(false, true, origin, window, cx);
                            for layer in [Layer::Text, Layer::Decorations] {
                                self.painter.paint_frame(
                                    &popup.frame,
                                    origin,
                                    None,
                                    metrics.cw,
                                    &self.font,
                                    &self.popup_highlights,
                                    &[],
                                    Some(Part { area: &all, layer }),
                                    None,
                                    window,
                                    cx,
                                );
                            }
                            self.paint_images(true, true, origin, window, cx);
                        },
                    );
                },
            );
            self.painter.release_idle_images(window);
        });
        (self.sequence != 0).then_some(self.sequence)
    }

    fn paint_regions(
        &mut self,
        layer: Layer,
        origin: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(presentation) = self.presentation.as_ref() else {
            return;
        };
        for region in &self.regions {
            let mask = pixel_rect(region.rect, origin, presentation.metrics);
            window.with_content_mask(Some(ContentMask { bounds: mask }), |window| {
                self.painter.paint_frame(
                    &presentation.frame,
                    origin,
                    None,
                    presentation.metrics.cw,
                    &self.font,
                    &self.highlights,
                    &[],
                    Some(Part {
                        area: &region.area,
                        layer,
                    }),
                    None,
                    window,
                    cx,
                );
            });
        }
    }

    fn paint_images(
        &mut self,
        above: bool,
        is_popup: bool,
        origin: Point<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(presentation) = self.presentation.as_ref() else {
            return;
        };
        let popup = presentation.popup.as_ref();
        let (frame, target) = if is_popup {
            let Some(popup) = popup else {
                return;
            };
            (&popup.frame, ImageTarget::Popup(&popup.id))
        } else {
            (&presentation.frame, ImageTarget::Main)
        };
        for placement in &presentation.placements {
            if (placement.z >= 0) != above {
                continue;
            }
            let clip = if is_popup {
                Some(live::frame_rect(frame))
            } else {
                live::placement_clip(presentation, placement)
            };
            let Some(clip) = clip else {
                continue;
            };
            window.with_content_mask(
                Some(ContentMask {
                    bounds: pixel_rect(clip, origin, presentation.metrics),
                }),
                |window| {
                    self.painter.paint_frame(
                        frame,
                        origin,
                        None,
                        presentation.metrics.cw,
                        &self.font,
                        &[],
                        &[],
                        Some(Part {
                            area: &[],
                            layer: if above {
                                Layer::Decorations
                            } else {
                                Layer::Text
                            },
                        }),
                        Some(PlacedImages {
                            placements: std::slice::from_ref(placement),
                            images: &self.images,
                            target,
                        }),
                        window,
                        cx,
                    );
                },
            );
        }
    }
}

fn highlights(spans: &[SelectionSpan]) -> Vec<Highlight> {
    spans
        .iter()
        .map(|span| Highlight {
            row: span.row,
            columns: span.columns.clone(),
            tint: Tint::Selection,
        })
        .collect()
}
fn pixel_rect(rect: SurfaceRect, origin: Point<Pixels>, metrics: Metrics) -> Bounds<Pixels> {
    Bounds::new(
        origin
            + point(
                px(f32::from(rect.x) * metrics.cw),
                px(f32::from(rect.y) * metrics.ch),
            ),
        size(
            px(f32::from(rect.width) * metrics.cw),
            px(f32::from(rect.height) * metrics.ch),
        ),
    )
}

fn regions(presentation: &Presentation) -> Vec<Region> {
    let mut regions: Vec<Region> = Vec::new();
    let mut previous = HashMap::new();
    for row in 0..presentation.frame.height {
        let mut current = HashMap::new();
        for columns in live::row_runs(&presentation.frame, &presentation.panes, row) {
            let key = (columns.start, columns.end);
            let index = if let Some(&index) = previous.get(&key) {
                let region: &mut Region = &mut regions[index];
                region.rect.height += 1;
                region.area.push(Span { row, columns });
                index
            } else {
                let index = regions.len();
                regions.push(Region {
                    rect: SurfaceRect {
                        x: columns.start,
                        y: row,
                        width: columns.end - columns.start,
                        height: 1,
                    },
                    area: vec![Span { row, columns }],
                });
                index
            };
            current.insert(key, index);
        }
        previous = current;
    }
    regions
}
