//! Browser host for the parent's existing live terminal presentation. No input or transport.
use crate::Scene;
use gpui::{
    App, AppContext, AsyncApp, Context, Entity, IntoElement, Render, Styled, Window, WindowOptions,
    canvas,
};
use gpui_web::{CanvasFontFallback, WebBackendPreference};
use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    rc::Rc,
};
use wasm_bindgen::prelude::*;

thread_local! {
    static STARTED: Cell<bool> = const { Cell::new(false) };
    static PAINTED_SEQUENCE: Cell<u32> = const { Cell::new(0) };
    static HOST: RefCell<Option<(AsyncApp, Entity<LiveHost>)>> = const { RefCell::new(None) };
}

struct LiveHost {
    scene: Rc<RefCell<Scene>>,
    on_painted: js_sys::Function,
}
impl Render for LiveHost {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let scene = self.scene.clone();
        let on_painted = self.on_painted.clone();
        canvas(
            |_, _, _| (),
            move |bounds, (), window, cx| {
                if bounds.size.width <= gpui::px(0.) || bounds.size.height <= gpui::px(0.) {
                    return;
                }
                let Some(sequence) = scene.borrow_mut().paint(bounds, window, cx) else {
                    return;
                };
                if PAINTED_SEQUENCE.get() != sequence {
                    PAINTED_SEQUENCE.set(sequence);
                    // Only the parent's opaque sequence crosses this callback. The callback
                    // acknowledges CPU scene construction, not GPU/display completion.
                    let _ = on_painted.call1(&JsValue::NULL, &JsValue::from(sequence));
                }
            },
        )
        .size_full()
    }
}
fn js_error(message: &'static str) -> JsValue {
    JsValue::from_str(message)
}

/// Start one input-free GPUI window. Backend Auto tries WebGPU then WebGL.
/// All terminal sizing remains owned by the parent; font measurement never resizes a PTY.
/// WASM launch is asynchronous: readiness follows HOST installation, not `app.run` returning.
#[wasm_bindgen]
pub fn start(
    on_painted: js_sys::Function,
    on_ready: js_sys::Function,
    on_error: js_sys::Function,
) -> Result<(), JsValue> {
    if STARTED.get() {
        return Err(js_error("The live renderer is already started."));
    }
    let platform = Rc::new(gpui_web::WebPlatform::new_with_backend_and_font_fallback(
        false,
        WebBackendPreference::Auto,
        CanvasFontFallback::EmojiAndCjk,
    ));
    let http_client = std::sync::Arc::new(platform.fetch_http_client());
    let app = gpui::Application::with_platform(platform).with_http_client(http_client);
    let text_system = app.text_system();
    text_system
        .add_fonts(vec![Cow::Borrowed(herdr_renderer_font::FONT)])
        .map_err(|_| js_error("Could not load the renderer font."))?;
    let selected = text_system
        .all_font_names()
        .into_iter()
        .find(|name| name.eq_ignore_ascii_case(herdr_renderer_font::FAMILY))
        .ok_or_else(|| js_error("The renderer font family is unavailable."))?;
    STARTED.set(true);
    app.run(move |cx: &mut App| {
        let result = cx.open_window(
            WindowOptions {
                focus: false,
                ..WindowOptions::default()
            },
            move |_, cx| {
                cx.new(|_| LiveHost {
                    scene: Rc::new(RefCell::new(Scene::new(selected))),
                    on_painted,
                })
            },
        );
        match result.and_then(|window| window.entity(cx)) {
            Ok(host) => {
                HOST.with_borrow_mut(|slot| *slot = Some((cx.to_async(), host)));
                let _ = on_ready.call0(&JsValue::NULL);
            }
            Err(_) => {
                // This callback runs after start() returned. Do not retain an error string
                // that the caller can no longer observe, or export backend error details.
                let _ = on_error.call0(&JsValue::NULL);
            }
        }
    });
    Ok(())
}

/// Accept one complete presentation. GPUI schedules rendering; this is not a paint receipt.
#[wasm_bindgen]
pub fn present(serialized: &str, sequence: u32) -> Result<(), JsValue> {
    HOST.with_borrow(|slot| {
        let Some((cx, host)) = slot else {
            return Err(js_error("The renderer is not ready."));
        };
        cx.update(|cx| {
            host.update(cx, |host, cx| {
                let result = host.scene.borrow_mut().present(serialized, sequence);
                if result.is_err() {
                    // Invalid content must not leave an old owner frame eligible for acknowledgement.
                    host.scene.borrow_mut().clear(0);
                    PAINTED_SEQUENCE.set(0);
                }
                cx.notify();
                result.map_err(js_error)
            })
        })
    })
}

/// Erase the current presentation and image bytes. Acknowledge only after the blank scene paint.
#[wasm_bindgen]
pub fn clear(sequence: u32) -> Result<(), JsValue> {
    HOST.with_borrow(|slot| {
        let Some((cx, host)) = slot else {
            return Err(js_error("The renderer is not ready."));
        };
        cx.update(|cx| {
            host.update(cx, |host, cx| {
                host.scene.borrow_mut().clear(sequence);
                PAINTED_SEQUENCE.set(0);
                cx.notify();
            })
        });
        Ok(())
    })
}
