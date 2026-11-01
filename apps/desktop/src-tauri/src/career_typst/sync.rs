//! Typst bidirectional sync: maps editor source lines <-> PDF layout frames.
//!
//! Unlike LaTeX which requires parsing external `.synctex` or `.synctex.gz`
//! disk artifacts, Typst evaluates and lays out documents in-process, embedding
//! AST [`Span`] provenance directly into each glyph and visual element inside
//! the [`typst::layout::Frame`] tree.

use std::path::Path;

use typst::layout::{Abs, Frame, FrameItem, Point, Transform};
use typst::syntax::{FileId, RootedPath, Span, VirtualPath, VirtualRoot};
use typst::{World, WorldExt};
use typst_layout::PagedDocument;

use super::project::ProjectWorld;
use crate::latex::{SynctexForwardResult, SynctexResult};

/// Internal representation of a layout element associated with an AST span.
#[derive(Debug, Clone)]
pub struct LayoutSpanBox {
    pub span: Span,
    pub page: u32, // 1-based page index
    pub x: f64,    // PDF points, top-left origin
    pub y: f64,    // PDF points, top-left origin
    pub width: f64,
    pub height: f64,
}

/// Recursively walks a Typst [`Frame`] and collects all bounding boxes with valid spans.
pub fn collect_frame_spans(
    frame: &Frame,
    current_transform: Transform,
    page: u32,
    out: &mut Vec<LayoutSpanBox>,
) {
    for (point, item) in frame.items() {
        let item_transform = current_transform.pre_concat(Transform::translate(point.x, point.y));

        match item {
            FrameItem::Group(group) => {
                let group_transform = item_transform.pre_concat(group.transform);
                collect_frame_spans(&group.frame, group_transform, page, out);
            }
            FrameItem::Text(text) => {
                let font_size = text.size;
                let mut cursor_x = Abs::zero();

                let mut active_span: Option<Span> = None;
                let mut span_start_x = cursor_x;
                let mut span_width = Abs::zero();

                for glyph in &text.glyphs {
                    let g_span = glyph.span.0;
                    let g_adv = glyph.x_advance.at(font_size);

                    if active_span == Some(g_span) {
                        span_width += g_adv;
                    } else {
                        if let Some(prev) = active_span {
                            if !prev.is_detached() {
                                let origin =
                                    Point::new(span_start_x, -font_size).transform(item_transform);
                                out.push(LayoutSpanBox {
                                    span: prev,
                                    page,
                                    x: origin.x.to_pt(),
                                    y: origin.y.to_pt(),
                                    width: span_width.to_pt().max(1.0),
                                    height: font_size.to_pt().max(1.0),
                                });
                            }
                        }
                        active_span = Some(g_span);
                        span_start_x = cursor_x + glyph.x_offset.at(font_size);
                        span_width = g_adv;
                    }
                    cursor_x += g_adv;
                }

                if let Some(last) = active_span {
                    if !last.is_detached() {
                        let origin = Point::new(span_start_x, -font_size).transform(item_transform);
                        out.push(LayoutSpanBox {
                            span: last,
                            page,
                            x: origin.x.to_pt(),
                            y: origin.y.to_pt(),
                            width: span_width.to_pt().max(1.0),
                            height: font_size.to_pt().max(1.0),
                        });
                    }
                }
            }
            FrameItem::Shape(shape, span) => {
                if !span.is_detached() {
                    let bbox = shape.bbox(true);
                    let origin = bbox.min.transform(item_transform);
                    let (w, h) = (bbox.size().x, bbox.size().y);
                    out.push(LayoutSpanBox {
                        span: *span,
                        page,
                        x: origin.x.to_pt(),
                        y: origin.y.to_pt(),
                        width: w.to_pt().max(1.0),
                        height: h.to_pt().max(1.0),
                    });
                }
            }
            FrameItem::Image(_img, size, span) if !span.is_detached() => {
                let origin = Point::zero().transform(item_transform);
                out.push(LayoutSpanBox {
                    span: *span,
                    page,
                    x: origin.x.to_pt(),
                    y: origin.y.to_pt(),
                    width: size.x.to_pt().max(1.0),
                    height: size.y.to_pt().max(1.0),
                });
            }
            _ => {}
        }
    }
}

/// Forward Sync: maps editor source position (file, line, column) to PDF (page, x, y, width, height).
#[tauri::command]
pub async fn typst_sync_forward(
    project_dir: String,
    main_file: String,
    file: String,
    line: u32,
    column: Option<u32>,
) -> Result<Option<SynctexForwardResult>, String> {
    tokio::task::spawn_blocking(move || {
        let root = Path::new(&project_dir);
        let world = match ProjectWorld::new(root, &main_file) {
            Ok(w) => w,
            Err(e) => return Err(format!("Failed to initialize ProjectWorld: {e}")),
        };

        let compiled = typst::compile::<PagedDocument>(&world);
        typst::comemo::evict(10);
        let doc = match compiled.output {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };

        let norm_file = file
            .replace('\\', "/")
            .trim_start_matches("./")
            .trim_start_matches('/')
            .to_string();
        let vpath = VirtualPath::new(&norm_file)
            .map_err(|e| format!("Invalid file path {norm_file}: {e}"))?;
        let target_id = FileId::new(RootedPath::new(VirtualRoot::Project, vpath));

        let source = match world.source(target_id) {
            Ok(s) => s,
            Err(_) => return Ok(None),
        };

        let num_lines = source.lines().len_lines() as u32;
        if line == 0 || line > num_lines {
            return Ok(None);
        }

        // Collect all frames from all pages
        let mut elements = Vec::new();
        for (idx, page) in doc.pages().iter().enumerate() {
            collect_frame_spans(
                &page.frame,
                Transform::identity(),
                (idx + 1) as u32,
                &mut elements,
            );
        }

        // Map spans in target file to (page, line, col, x, y, w, h)
        let mut candidates = Vec::new();
        for el in elements {
            if el.span.id() != Some(target_id) {
                continue;
            }
            if let Some(range) = world.range(el.span) {
                if let Some((l0, c0)) = source.lines().byte_to_line_column(range.start) {
                    candidates.push((
                        el.page,
                        (l0 + 1) as u32,
                        (c0 + 1) as u32,
                        el.x,
                        el.y,
                        el.width,
                        el.height,
                    ));
                }
            }
        }

        if candidates.is_empty() {
            return Ok(None);
        }

        struct CandidateMatch {
            page: u32,
            line: u32,
            line_dist: u32,
            col_dist: u32,
            x: f64,
            y: f64,
            width: f64,
            height: f64,
        }

        let mut best: Option<CandidateMatch> = None;

        for (p, l, c, x, y, w, h) in candidates {
            let line_dist = l.abs_diff(line);
            let col_dist = column.map_or(0, |col| c.abs_diff(col));
            let replace = match best {
                None => true,
                Some(ref prev) => {
                    if line_dist < prev.line_dist {
                        true
                    } else if line_dist == prev.line_dist {
                        if col_dist < prev.col_dist {
                            true
                        } else if col_dist == prev.col_dist {
                            l >= line && prev.line < line
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                }
            };
            if replace {
                best = Some(CandidateMatch {
                    page: p,
                    line: l,
                    line_dist,
                    col_dist,
                    x,
                    y,
                    width: w,
                    height: h,
                });
            }
        }

        let best_match = match best {
            Some(b) => b,
            None => return Ok(None),
        };

        Ok(Some(SynctexForwardResult {
            page: best_match.page,
            x: best_match.x,
            y: best_match.y,
            width: best_match.width.max(24.0),
            height: best_match.height.max(12.0),
        }))
    })
    .await
    .map_err(|e| format!("typst_sync_forward worker panicked: {e}"))?
}

/// Inverse Sync: maps PDF preview click (page, x, y) in points to source location (file, line, column).
#[tauri::command]
pub async fn typst_sync_inverse(
    project_dir: String,
    main_file: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<Option<SynctexResult>, String> {
    tokio::task::spawn_blocking(move || {
        let root = Path::new(&project_dir);
        let world = match ProjectWorld::new(root, &main_file) {
            Ok(w) => w,
            Err(e) => return Err(format!("Failed to initialize ProjectWorld: {e}")),
        };

        let compiled = typst::compile::<PagedDocument>(&world);
        typst::comemo::evict(10);
        let doc = match compiled.output {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };

        let pages = doc.pages();
        if page == 0 || page as usize > pages.len() {
            return Ok(None);
        }

        let target_page = &pages[(page - 1) as usize];
        let mut elements = Vec::new();
        collect_frame_spans(
            &target_page.frame,
            Transform::identity(),
            page,
            &mut elements,
        );

        if elements.is_empty() {
            return Ok(None);
        }

        // Find nearest bounding box using vertical-priority distance
        let mut best: Option<(Span, f64, f64, f64)> = None;
        let mut best_dist = f64::MAX;

        for el in elements {
            let x_min = el.x;
            let x_max = el.x + el.width;
            let y_min = el.y;
            let y_max = el.y + el.height;

            let dx = if x < x_min {
                x_min - x
            } else if x > x_max {
                x - x_max
            } else {
                0.0
            };

            let dy = if y < y_min {
                y_min - y
            } else if y > y_max {
                y - y_max
            } else {
                0.0
            };

            // Lines in documents are horizontal; vertical distance is weighted 2x
            let dist = dx * dx + (dy * 2.0) * (dy * 2.0);
            if dist < best_dist {
                best_dist = dist;
                best = Some((el.span, dist, dx, dy));
            }
        }

        let Some((span, _, dx, dy)) = best else {
            return Ok(None);
        };

        // Margin check: if the click is in the empty page margins far from any text
        if dy > 40.0 || (dx > 40.0 && dy > 20.0) {
            return Ok(None);
        }

        let Some(file_id) = span.id() else {
            return Ok(None);
        };

        let file = file_id.vpath().get_without_slash().to_string();
        let Some(range) = world.range(span) else {
            return Ok(None);
        };

        let source = match world.source(file_id) {
            Ok(s) => s,
            Err(_) => return Ok(None),
        };

        let (l0, c0) = match source.lines().byte_to_line_column(range.start) {
            Some(lc) => lc,
            None => return Ok(None),
        };

        Ok(Some(SynctexResult {
            file,
            line: (l0 + 1) as u32,
            column: (c0 + 1) as u32,
        }))
    })
    .await
    .map_err(|e| format!("typst_sync_inverse worker panicked: {e}"))?
}
