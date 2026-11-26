//! A software renderer for `egui_kittest` snapshots: rasterises egui's
//! tessellated meshes on the CPU, so the window's screenshots need no GPU,
//! no display and no graphics library, and come out the same on every
//! x86_64 machine (plain `f32` arithmetic, no threads, no SIMD paths).
//!
//! It does what egui's own backends do: triangles with per-vertex colours
//! (premultiplied, gamma space) times a bilinearly sampled texture, blended
//! "premultiplied over", clipped to each primitive's clip rectangle. Pixel
//! centres are sampled once (egui feathers its own edges) with the top-left
//! fill rule, so triangles sharing an edge never blend a pixel twice.

use std::collections::HashMap;

use egui::epaint::{
    ClippedPrimitive, ImageData, Primitive, TextureId, Vertex, textures::TexturesDelta,
};
use egui::{Color32, TextureFilter, TextureOptions};
use egui_kittest::TestRenderer;

struct Texture {
    size: [usize; 2],
    pixels: Vec<Color32>,
    options: TextureOptions,
}

/// The renderer; pass it to `HarnessBuilder::renderer`.
#[derive(Default)]
pub struct CpuRenderer {
    textures: HashMap<TextureId, Texture>,
    to_free: Vec<TextureId>,
}

impl TestRenderer for CpuRenderer {
    fn handle_delta(&mut self, delta: &mut TexturesDelta) {
        for (id, image_delta) in delta
            .set
            .iter()
            .flat_map(|(id, ds)| ds.iter().map(move |d| (id, d)))
        {
            let ImageData::Color(image) = &image_delta.image;
            match image_delta.pos {
                None => {
                    self.textures.insert(
                        *id,
                        Texture {
                            size: image.size,
                            pixels: image.pixels.clone(),
                            options: image_delta.options,
                        },
                    );
                }
                Some([x0, y0]) => {
                    let Some(texture) = self.textures.get_mut(id) else {
                        continue;
                    };
                    texture.options = image_delta.options;
                    let [w, h] = image.size;
                    for y in 0..h {
                        for x in 0..w {
                            let (tx, ty) = (x0 + x, y0 + y);
                            if tx < texture.size[0] && ty < texture.size[1] {
                                texture.pixels[ty * texture.size[0] + tx] = image.pixels[y * w + x];
                            }
                        }
                    }
                }
            }
        }
        // Freed after the next paint, as the GPU renderers do.
        self.to_free.extend(delta.free.iter().copied());
        delta.clear();
    }

    fn render(
        &mut self,
        ctx: &egui::Context,
        output: &egui::FullOutput,
    ) -> Result<image::RgbaImage, String> {
        let ppp = ctx.pixels_per_point();
        let size = ctx.content_rect().size() * ppp;
        let (width, height) = (size.x.round() as usize, size.y.round() as usize);
        let mut target = Target {
            width,
            pixels: vec![[0.0; 4]; width * height],
        };
        for ClippedPrimitive {
            clip_rect,
            primitive,
        } in ctx.tessellate(output.shapes.clone(), ppp)
        {
            let Primitive::Mesh(mesh) = primitive else {
                return Err("paint callbacks are not supported".into());
            };
            let texture = self
                .textures
                .get(&mesh.texture_id)
                .ok_or_else(|| format!("unknown texture {:?}", mesh.texture_id))?;
            let clip = [
                (clip_rect.min.x * ppp).round().max(0.0) as usize,
                (clip_rect.min.y * ppp).round().max(0.0) as usize,
                ((clip_rect.max.x * ppp).round().max(0.0) as usize).min(width),
                ((clip_rect.max.y * ppp).round().max(0.0) as usize).min(height),
            ];
            for triangle in mesh.indices.as_chunks::<3>().0 {
                let [a, b, c] = [0, 1, 2].map(|i| &mesh.vertices[triangle[i] as usize]);
                target.triangle([a, b, c], ppp, clip, texture);
            }
        }
        for id in self.to_free.drain(..) {
            self.textures.remove(&id);
        }
        let mut image = image::RgbaImage::new(width as u32, height as u32);
        for (pixel, value) in image.pixels_mut().zip(&target.pixels) {
            // Premultiplied to straight alpha, as the GPU renderers read it back.
            let alpha = value[3];
            let straight = |c: f32| {
                if alpha > 0.0 { to_u8(c / alpha) } else { 0 }
            };
            *pixel = image::Rgba([
                straight(value[0]),
                straight(value[1]),
                straight(value[2]),
                to_u8(alpha),
            ]);
        }
        Ok(image)
    }
}

fn to_u8(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Premultiplied RGBA in 0..1, gamma space (as egui blends).
struct Target {
    width: usize,
    pixels: Vec<[f32; 4]>,
}

/// Twice the signed area of (a, b, p).
fn edge(a: [f32; 2], b: [f32; 2], p: [f32; 2]) -> f32 {
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
}

impl Target {
    fn triangle(&mut self, vertices: [&Vertex; 3], ppp: f32, clip: [usize; 4], texture: &Texture) {
        let mut p = vertices.map(|v| [v.pos.x * ppp, v.pos.y * ppp]);
        let mut v = vertices;
        let mut area = edge(p[0], p[1], p[2]);
        if area == 0.0 {
            return;
        }
        if area < 0.0 {
            p.swap(1, 2);
            v.swap(1, 2);
            area = -area;
        }
        let min_x = p.iter().map(|q| q[0]).fold(f32::INFINITY, f32::min);
        let max_x = p.iter().map(|q| q[0]).fold(f32::NEG_INFINITY, f32::max);
        let min_y = p.iter().map(|q| q[1]).fold(f32::INFINITY, f32::min);
        let max_y = p.iter().map(|q| q[1]).fold(f32::NEG_INFINITY, f32::max);
        let x0 = (min_x.floor().max(0.0) as usize).max(clip[0]);
        let y0 = (min_y.floor().max(0.0) as usize).max(clip[1]);
        let x1 = ((max_x.ceil().max(0.0) as usize) + 1).min(clip[2]);
        let y1 = ((max_y.ceil().max(0.0) as usize) + 1).min(clip[3]);
        // Top-left rule: a pixel centre exactly on an edge belongs to only
        // one of the two triangles sharing that edge, since they run along
        // it in opposite directions.
        let top_left = |a: [f32; 2], b: [f32; 2]| {
            let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
            (dy == 0.0 && dx < 0.0) || dy > 0.0
        };
        let edges = [(1, 2), (2, 0), (0, 1)];
        let inclusive = edges.map(|(i, j)| top_left(p[i], p[j]));
        for y in y0..y1 {
            for x in x0..x1 {
                let centre = [x as f32 + 0.5, y as f32 + 0.5];
                let w = edges.map(|(i, j)| edge(p[i], p[j], centre));
                let inside = w
                    .iter()
                    .zip(inclusive)
                    .all(|(&w, inclusive)| w > 0.0 || (w == 0.0 && inclusive));
                if !inside {
                    continue;
                }
                let weights = w.map(|w| w / area);
                let lerp = |f: &dyn Fn(&Vertex) -> f32| {
                    weights[0] * f(v[0]) + weights[1] * f(v[1]) + weights[2] * f(v[2])
                };
                let u = lerp(&|v| v.uv.x);
                let t = lerp(&|v| v.uv.y);
                let colour = [0, 1, 2, 3].map(|k| lerp(&|v| f32::from(v.color[k]) / 255.0));
                let texel = texture.sample(u, t);
                let src = [0, 1, 2, 3].map(|k| colour[k] * texel[k]);
                let dst = &mut self.pixels[y * self.width + x];
                for k in 0..4 {
                    dst[k] = src[k] + dst[k] * (1.0 - src[3]);
                }
            }
        }
    }
}

impl Texture {
    /// Premultiplied RGBA in 0..1 at (u, t), clamped to the edge.
    fn sample(&self, u: f32, t: f32) -> [f32; 4] {
        let [w, h] = self.size;
        let texel = |x: isize, y: isize| {
            let x = x.clamp(0, w as isize - 1) as usize;
            let y = y.clamp(0, h as isize - 1) as usize;
            let c = self.pixels[y * w + x];
            [c.r(), c.g(), c.b(), c.a()].map(|c| f32::from(c) / 255.0)
        };
        let (fx, fy) = (u * w as f32 - 0.5, t * h as f32 - 0.5);
        if self.options.magnification == TextureFilter::Nearest {
            return texel(fx.round() as isize, fy.round() as isize);
        }
        let (x, y) = (fx.floor(), fy.floor());
        let (ax, ay) = (fx - x, fy - y);
        let (x, y) = (x as isize, y as isize);
        let [c00, c10, c01, c11] = [
            texel(x, y),
            texel(x + 1, y),
            texel(x, y + 1),
            texel(x + 1, y + 1),
        ];
        [0, 1, 2, 3].map(|k| {
            let top = c00[k] + (c10[k] - c00[k]) * ax;
            let bottom = c01[k] + (c11[k] - c01[k]) * ax;
            top + (bottom - top) * ay
        })
    }
}
