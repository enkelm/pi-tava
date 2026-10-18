//! The renderer's bundled face. The browser and coverage tests consume these same bytes.
//! Font data is SIL OFL 1.1; see ../fonts/JetBrainsMonoNerdFont-OFL.txt.

pub const FAMILY: &str = "JetBrainsMono Nerd Font Mono";
pub const FONT: &[u8] = include_bytes!("../../fonts/JetBrainsMonoNerdFontMono-Regular.ttf");

#[cfg(test)]
mod tests {
    use super::*;
    use ttf_parser::Face;

    #[test]
    fn bundled_face_has_terminal_symbols_and_nerd_icons() {
        let face = Face::parse(FONT, 0).expect("the renderer must load a valid TrueType face");
        // Independent public terminal samples: the old Fira face lacks the check mark and
        // the icon ranges. Every sample must have a real outline, not glyph 0/.notdef.
        for symbol in [
            'M',
            'é',
            '\u{0301}',
            '│',
            '█',
            '✓',
            '✗',
            '▶',
            '⌘',
            '⚡',
            '\u{e0b0}',
            '\u{f418}',
            '\u{f07b}',
            '\u{f0001}',
        ] {
            let glyph = face.glyph_index(symbol).unwrap_or_else(|| {
                panic!(
                    "renderer has no glyph for U+{:04X} {symbol}",
                    u32::from(symbol)
                )
            });
            assert_ne!(
                glyph.0,
                0,
                "U+{:04X} resolves to .notdef",
                u32::from(symbol)
            );
            let bounds = face
                .glyph_bounding_box(glyph)
                .expect("visible glyph outline");
            assert!(
                bounds.x_max > bounds.x_min && bounds.y_max > bounds.y_min,
                "U+{:04X} has an empty outline",
                u32::from(symbol)
            );
        }
        assert!(
            face.is_monospaced(),
            "terminal symbols must use the Mono face"
        );
        // GPUI Web uses fontdb 0.23 without system fonts; startup selects from each
        // face's first family, not every alias in the TrueType name table.
        let mut database = fontdb::Database::new();
        database.load_font_data(FONT.to_vec());
        let selected = database
            .query(&fontdb::Query {
                families: &[fontdb::Family::Name(FAMILY)],
                ..fontdb::Query::default()
            })
            .expect("GPUI must be able to select the bundled family");
        assert_eq!(database.face(selected).unwrap().families[0].0, FAMILY);
    }
}
