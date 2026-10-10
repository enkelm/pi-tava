use base64::{Engine, engine::general_purpose::STANDARD};
use herdr_client::SurfaceImages;
use herdr_protocol::{PaneSurfaceFrame, SurfaceGraphicsAssetKey};
use serde::Serialize;
use serde_json::Value;
use std::{
    io::{self, Write},
    sync::Arc,
};

pub const MAX_OUTPUT: usize = 32 * 1024 * 1024 - 1;
pub const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;

/// A serializing writer cannot grow past the JSON frame budget.
struct Bounded(Vec<u8>);
impl Write for Bounded {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_OUTPUT.saturating_sub(self.0.len()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "output exceeds 32 MiB",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub fn encode(value: &impl Serialize) -> Result<Vec<u8>, String> {
    let mut out = Bounded(Vec::new());
    serde_json::to_writer(&mut out, value)
        .map_err(|_| "output exceeds JSON frame limits".to_owned())?;
    let mut bytes = exact_json_integers(out.0).map_err(|_| "output exceeds JSON frame limits")?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// The hot surface path serializes the native frame once, without a Value tree,
/// reparsing cells, or copying the JSON unless it contains unsafe JS integers.
pub fn surface_line(surface: &PaneSurfaceFrame) -> Result<Vec<u8>, String> {
    #[derive(Serialize)]
    struct Event<'a> {
        r#type: &'static str,
        surface: &'a PaneSurfaceFrame,
    }
    encode(&Event {
        r#type: "surface",
        surface,
    })
}

/// Scan valid serialized JSON in linear time. Only integer tokens outside strings
/// can change; decimal/exponent floats retain the serializer's representation.
fn exact_json_integers(bytes: Vec<u8>) -> io::Result<Vec<u8>> {
    let mut index = 0;
    let mut copied = 0;
    let mut output: Option<Bounded> = None;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                index += 1;
                while index < bytes.len() {
                    match bytes[index] {
                        b'\\' => index += 2,
                        b'"' => {
                            index += 1;
                            break;
                        }
                        _ => index += 1,
                    }
                }
            }
            b'-' | b'0'..=b'9' => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && matches!(bytes[index], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
                {
                    index += 1;
                }
                let digits = &bytes[start + usize::from(bytes[start] == b'-')..index];
                let integer = digits.iter().all(u8::is_ascii_digit);
                if integer
                    && (digits.len() > 16 || (digits.len() == 16 && digits > b"9007199254740991"))
                {
                    let out =
                        output.get_or_insert_with(|| Bounded(Vec::with_capacity(bytes.len())));
                    out.write_all(&bytes[copied..start])?;
                    out.write_all(b"\"")?;
                    out.write_all(&bytes[start..index])?;
                    out.write_all(b"\"")?;
                    copied = index;
                }
            }
            _ => index += 1,
        }
    }
    if let Some(mut output) = output {
        output.write_all(&bytes[copied..])?;
        Ok(output.0)
    } else {
        Ok(bytes)
    }
}

/// JS must not round 64-bit revision or graphics asset identities. Encode large
/// integers as decimal strings, consistently in images and placement keys.
pub fn value(value: &impl Serialize) -> Result<Value, String> {
    let bytes = encode(value)?;
    serde_json::from_slice(&bytes).map_err(|_| "invalid output JSON".into())
}

/// The pinned client's SurfaceImages exposes get(), but not iteration. Discover
/// keys from full surface placements and retained_assets. Keep previously seen
/// keys while the client still retains them, including across future projections.
/// A newly discovered image is published before its first visible surface.
#[derive(Default)]
pub struct Images {
    store: Arc<SurfaceImages>,
    keys: Vec<SurfaceGraphicsAssetKey>,
    published: Vec<(SurfaceGraphicsAssetKey, u64)>,
}
impl Images {
    pub fn update(&mut self, store: Arc<SurfaceImages>) -> Result<Vec<u8>, String> {
        self.store = store;
        self.keys.retain(|key| self.store.get(key).is_some());
        self.event()
    }
    pub fn before_surface(
        &mut self,
        surface: &PaneSurfaceFrame,
    ) -> Result<Option<Vec<u8>>, String> {
        for key in surface
            .graphics
            .placements
            .iter()
            .map(|p| &p.asset)
            .chain(&surface.graphics.retained_assets)
        {
            if self.store.get(key).is_some() && !self.keys.contains(key) {
                self.keys.push(key.clone());
            }
        }
        if self.identities() != self.published {
            Ok(Some(self.event()?))
        } else {
            Ok(None)
        }
    }
    fn identities(&self) -> Vec<(SurfaceGraphicsAssetKey, u64)> {
        self.keys
            .iter()
            .filter_map(|key| self.store.get(key).map(|img| (key.clone(), img.serial())))
            .collect()
    }
    fn event(&mut self) -> Result<Vec<u8>, String> {
        let total: usize = self
            .keys
            .iter()
            .filter_map(|key| self.store.get(key))
            .map(|img| img.data().len())
            .sum();
        if total > MAX_IMAGE_BYTES {
            return Err("images exceed helper's 16 MiB decoded-base64 budget".into());
        }
        #[derive(Serialize)]
        struct Image<'a> {
            key: &'a SurfaceGraphicsAssetKey,
            serial: u64,
            encoding: &'static str,
            data: String,
        }
        #[derive(Serialize)]
        struct Event<'a> {
            r#type: &'static str,
            images: Vec<Image<'a>>,
        }
        let images = self
            .keys
            .iter()
            .filter_map(|key| {
                self.store.get(key).map(|img| Image {
                    key,
                    serial: img.serial(),
                    encoding: "base64",
                    data: STANDARD.encode(img.data()),
                })
            })
            .collect();
        // Serialize native keys directly, exactly as the surface path does. This
        // also keeps source object ordering identical for simple browser caches.
        let line = encode(&Event {
            r#type: "images",
            images,
        })?;
        self.published = self.identities();
        Ok(line)
    }
}

pub fn validate_surface(surface: &PaneSurfaceFrame) -> Result<(), String> {
    let validate = |frame: &herdr_protocol::FrameData| {
        super::input::geometry(frame.width, frame.height, 0, 0).map_err(str::to_owned)
    };
    validate(&surface.frame)?;
    if let Some(popup) = &surface.popup {
        validate(&popup.frame)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn integer_scanner_preserves_strings_floats_and_safe_boundaries() {
        let original = json!({"safe":9007199254740991u64,"large":9007199254740992u64,"negative":i64::MIN,"float":1.25e30,"text":"quoted \\\"18446744073709551615\\\" and \\\\ escape"});
        let encoded = encode(&original).unwrap();
        let result: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(result["safe"], original["safe"]);
        assert_eq!(result["large"], "9007199254740992");
        assert_eq!(result["negative"], i64::MIN.to_string());
        assert_eq!(result["float"], original["float"]);
        assert_eq!(result["text"], original["text"]);
    }
    #[test]
    fn exact_integer_json() {
        let v = value(&json!({"key":{"data_fingerprint":u64::MAX}, "revision":7})).unwrap();
        assert_eq!(v["key"]["data_fingerprint"], "18446744073709551615");
        assert_eq!(v["revision"], 7);
    }
}
