# Preview fonts

The self-hosted WOFF2 files are subsets derived from the installed Noto Sans SC and Noto Serif SC variable fonts. Their internal family names are changed to QSA Preview Sans SC / QSA Preview Serif SC. Both retain the SIL Open Font License 1.1; the complete licenses are included in this directory.

- `qsa-sans-sc.woff2`: weights 400–700; current static UI and sample content.
- `qsa-serif-sc.woff2`: weights 600–800; page and section headings.
- Builder: `.impeccable/tools/build-fonts.py` (requires fontTools and brotli).

New real content can use the CSS system fallback. Regenerate the subsets when expanding fixed UI content. This is a static design preview, not a production font pipeline.
