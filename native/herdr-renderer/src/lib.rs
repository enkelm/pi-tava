//! Rust GPUI terminal painter and paint-only browser host. No sockets or input transport.

extern crate self as herdr_client;

pub use herdr_protocol as protocol;
pub use surface_images::{MAX_IMAGE_SIDE, SurfaceImage, SurfaceImages, valid_asset};

mod config;
mod scene;
mod surface_images;
mod terminal;
mod upstream;
#[cfg(target_family = "wasm")]
mod web;

pub(crate) use scene::Scene;

#[derive(Debug)]
pub enum Error {
    PaneImageLimit,
    PaneImageDecode(image::ImageError),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PaneImageLimit => f.write_str("image exceeds renderer limits"),
            Self::PaneImageDecode(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
