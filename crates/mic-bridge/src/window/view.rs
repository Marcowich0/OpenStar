//! How the window draws a [`WindowState`]: a light Bubble Pop look (cream
//! page, ink text, white rounded cards, coloured pills; the colours are the
//! Stage's tokens from `web/src/theme/tokens.css`). It only shows: there
//! is nothing to click, because switching channels on, naming them and
//! their Mic thresholds belong to the Stage.

use egui::{
    Align, Color32, CornerRadius, Frame, Layout, Margin, RichText, Sense, Stroke, Ui, vec2,
};

use super::state::{ChannelRow, InterfaceRows, Status, WindowState};

/// The window's size in points, also the size of its snapshots.
pub const WINDOW_SIZE: [f32; 2] = [480.0, 420.0];

// Bubble Pop tokens (web/src/theme/tokens.css).
const CREAM: Color32 = Color32::from_rgb(0xff, 0xf6, 0xe9);
const WHITE: Color32 = Color32::from_rgb(0xff, 0xff, 0xff);
const INK: Color32 = Color32::from_rgb(0x2b, 0x2d, 0x42);
const INK_2: Color32 = Color32::from_rgb(0x5d, 0x60, 0x79);
const MUTE: Color32 = Color32::from_rgb(0x8a, 0x8c, 0xa0);
const PASSED: Color32 = Color32::from_rgb(0xec, 0xed, 0xf5);
const GREEN: Color32 = Color32::from_rgb(0x3d, 0xdc, 0x84);
const GREEN_LEDGE: Color32 = Color32::from_rgb(0x24, 0xa8, 0x62);
const YELLOW: Color32 = Color32::from_rgb(0xff, 0xc9, 0x3c);
const BLUE: Color32 = Color32::from_rgb(0x2e, 0xa8, 0xff);
const PINK: Color32 = Color32::from_rgb(0xff, 0x6f, 0xb5);
const WARN_BG: Color32 = Color32::from_rgb(0xff, 0xe1, 0xe4);
const WARN_FG: Color32 = Color32::from_rgb(0xb3, 0x19, 0x2b);
/// `--color-ledge`: ink at 14 %.
const LEDGE: Color32 = Color32::from_rgba_premultiplied(6, 6, 9, 36);

/// The meter's range: the floor is the Stage's −60 dB.
const METER_FLOOR_DBFS: f64 = -60.0;

/// Sets the light Bubble Pop look on `ctx`.
pub fn set_style(ctx: &egui::Context) {
    ctx.set_visuals(egui::Visuals::light());
    ctx.all_styles_mut(|style| {
        style.visuals.override_text_color = Some(INK);
        style.visuals.panel_fill = CREAM;
        style.visuals.window_fill = CREAM;
        style.spacing.item_spacing = vec2(8.0, 8.0);
    });
}

/// Draws the whole window into `ui`.
pub fn show(ui: &mut Ui, state: &WindowState) {
    let ctx = ui.ctx().clone();
    ctx.layer_painter(egui::LayerId::background()).rect_filled(
        ctx.content_rect(),
        CornerRadius::ZERO,
        CREAM,
    );
    egui::CentralPanel::default()
        .frame(Frame::new().fill(CREAM).inner_margin(Margin::same(20)))
        .show(ui, |ui| {
            ui.label(
                RichText::new("OpenStar Mic bridge")
                    .size(24.0)
                    .strong()
                    .color(INK),
            );
            ui.label(
                RichText::new(format!("Server: {}", state.server()))
                    .size(14.0)
                    .color(INK_2),
            );
            ui.add_space(6.0);
            status(ui, state.status());
            ui.add_space(6.0);
            egui::ScrollArea::vertical()
                .auto_shrink(false)
                .show(ui, |ui| {
                    let interfaces = state.interfaces();
                    if interfaces.is_empty() {
                        ui.label(
                            RichText::new("No audio interface found")
                                .size(15.0)
                                .color(MUTE),
                        );
                    }
                    for interface in &interfaces {
                        interface_card(ui, interface);
                    }
                });
        });
}

fn card(fill: Color32) -> Frame {
    Frame::new()
        .fill(fill)
        .corner_radius(CornerRadius::same(20))
        .stroke(Stroke::new(2.0, LEDGE))
        .inner_margin(Margin::symmetric(16, 12))
}

fn status(ui: &mut Ui, status: &Status) {
    let (fill, dot, title, detail) = match status {
        Status::Connecting { problem } => (WHITE, YELLOW, "Connecting…", problem.clone()),
        Status::Waiting { code } => (
            WHITE,
            BLUE,
            "Waiting for approval",
            Some(format!("Approve code {code} on the Stage's Mics screen.")),
        ),
        Status::Connected => (WHITE, GREEN, "Connected", None),
        Status::Stopped { problem } => (WARN_BG, WARN_FG, "Not running", Some(problem.clone())),
    };
    card(fill).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            let (rect, _) = ui.allocate_exact_size(vec2(14.0, 14.0), Sense::hover());
            ui.painter().circle_filled(rect.center(), 7.0, dot);
            ui.label(RichText::new(title).size(18.0).strong().color(INK));
            if let Status::Waiting { code } = status {
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    ui.label(RichText::new(code).size(30.0).strong().color(BLUE));
                });
            }
        });
        if let Some(detail) = detail {
            ui.label(RichText::new(detail).size(14.0).color(INK_2));
        }
    });
}

fn interface_card(ui: &mut Ui, interface: &InterfaceRows) {
    card(WHITE).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(&interface.label)
                    .size(17.0)
                    .strong()
                    .color(INK),
            );
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let state = if interface.open { "Open" } else { "Closed" };
                ui.label(RichText::new(state).size(13.0).color(MUTE));
            });
        });
        for row in &interface.channels {
            channel_row(ui, row);
        }
    });
    ui.add_space(4.0);
}

fn channel_row(ui: &mut Ui, row: &ChannelRow) {
    ui.horizontal(|ui| {
        pill(ui, row.switched_on);
        ui.label(RichText::new(&row.name).size(15.0).color(INK));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            match row.level_dbfs {
                Some(level) => meter(ui, level),
                None => {
                    ui.label(RichText::new("—").size(15.0).color(MUTE));
                }
            }
        });
    });
}

/// "On" or "Off": a label, not a switch.
fn pill(ui: &mut Ui, on: bool) {
    let (text, fill, stroke, colour) = if on {
        ("On", GREEN, GREEN_LEDGE, WHITE)
    } else {
        ("Off", PASSED, LEDGE, INK_2)
    };
    Frame::new()
        .fill(fill)
        .stroke(Stroke::new(1.5, stroke))
        .corner_radius(CornerRadius::same(10))
        .inner_margin(Margin::symmetric(8, 1))
        .show(ui, |ui| {
            ui.set_min_width(24.0);
            ui.label(RichText::new(text).size(13.0).strong().color(colour));
        });
}

/// The share of the meter a level fills: the Stage's −60 dB floor to 0 dB.
pub fn meter_fill(level_dbfs: f64) -> f32 {
    ((level_dbfs - METER_FLOOR_DBFS) / -METER_FLOOR_DBFS).clamp(0.0, 1.0) as f32
}

fn meter(ui: &mut Ui, level_dbfs: f64) {
    let (rect, _) = ui.allocate_exact_size(vec2(120.0, 12.0), Sense::hover());
    let painter = ui.painter();
    painter.rect_filled(rect, CornerRadius::same(6), PASSED);
    let fill = meter_fill(level_dbfs);
    if fill > 0.0 {
        let mut filled = rect;
        filled.set_width((rect.width() * fill).max(rect.height()));
        let colour = if fill > 0.9 { PINK } else { GREEN };
        painter.rect_filled(filled, CornerRadius::same(6), colour);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_meter_runs_from_the_stage_floor_to_full_scale() {
        assert_eq!(meter_fill(-100.0), 0.0);
        assert_eq!(meter_fill(-60.0), 0.0);
        assert_eq!(meter_fill(-30.0), 0.5);
        assert_eq!(meter_fill(0.0), 1.0);
        assert_eq!(meter_fill(3.0), 1.0);
    }
}
