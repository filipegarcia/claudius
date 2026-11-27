//! The overlay frame's rules (`components/overlays/Overlay.tsx`): its props
//! and their defaults, what closes it, the panel's size and place, and the
//! dragged panel's clamp. [`crate::view::frame::Overlay`] draws it.

/// `Overlay`'s props, with their defaults (Overlay.tsx:57-68).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameProps {
    /// `width = 640`: the panel's width, px (at most 92vw, [`Self::panel_width`]).
    pub width: f32,
    /// `dismissOnBackdrop = true`: when false only the X (or the consumer's
    /// own buttons) closes it (Overlay.tsx:12-18).
    pub dismiss_on_backdrop: bool,
    /// `onMinimize` was given: the header shows a minimize button
    /// (Overlay.tsx:170-179).
    pub minimizable: bool,
    /// `maxHeightVh = 80`.
    pub max_height_vh: f32,
    /// `backdrop = true`: the dimmed layer; without it the overlay is
    /// non-modal (Overlay.tsx:26-31).
    pub backdrop: bool,
    /// `draggable = false`: the header moves the panel (Overlay.tsx:32-38).
    pub draggable: bool,
}

impl Default for FrameProps {
    fn default() -> Self {
        FrameProps {
            width: 640.,
            dismiss_on_backdrop: true,
            minimizable: false,
            max_height_vh: 80.,
            backdrop: true,
            draggable: false,
        }
    }
}

impl FrameProps {
    /// The defaults at a width (`<Overlay width={680}>`).
    pub fn with_width(width: f32) -> Self {
        FrameProps {
            width,
            ..Default::default()
        }
    }

    /// Escape closes only while `dismissOnBackdrop` (Overlay.tsx:125-132:
    /// the window `keydown` listener isn't installed otherwise).
    pub fn escape_closes(&self) -> bool {
        self.dismiss_on_backdrop
    }

    /// A click on the dimmed layer closes (Overlay.tsx:142: `onClick` is set
    /// only with a backdrop and `dismissOnBackdrop`); a click on the panel
    /// doesn't (Overlay.tsx:146, `stopPropagation`).
    pub fn backdrop_click_closes(&self) -> bool {
        self.backdrop && self.dismiss_on_backdrop
    }

    /// Whether the full-window layer takes the pointer: without a backdrop
    /// it is `pointer-events-none` and only the panel does
    /// (Overlay.tsx:138-141).
    pub fn layer_takes_pointer(&self) -> bool {
        self.backdrop
    }

    /// `width: min(${width}px, 92vw)` (Overlay.tsx:148).
    pub fn panel_width(&self, viewport_width: f32) -> f32 {
        self.width.min(viewport_width * 0.92)
    }

    /// `maxHeight: ${maxHeightVh}vh` (Overlay.tsx:149).
    pub fn max_height(&self, viewport_height: f32) -> f32 {
        viewport_height * self.max_height_vh / 100.
    }
}

/// The layer's `pt-[8vh]`: the panel hangs 8% of the window down
/// (Overlay.tsx:137, `items-start`).
pub fn top_offset(viewport_height: f32) -> f32 {
    viewport_height * 0.08
}

/// The layer's `px-4`.
pub const SIDE_PADDING: f32 = 16.;

/// The panel's drag offset from its laid-out place, px.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Offset {
    pub x: f32,
    pub y: f32,
}

impl Offset {
    /// `transform` is set only for a non-zero offset (Overlay.tsx:150).
    pub fn is_moved(&self) -> bool {
        self.x != 0. || self.y != 0.
    }
}

/// The panel's un-dragged layout slot and its size, px (`PanelBox`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PanelBox {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

/// `clampOffset` (Overlay.tsx:46-55): keeps the dragged panel on screen and
/// below the title bar (`min_top`, the `--titlebar-height`).
pub fn clamp_offset(x: f32, y: f32, b: PanelBox, viewport: (f32, f32), min_top: f32) -> Offset {
    let max_left = 0f32.max(viewport.0 - b.width);
    let max_top = min_top.max(viewport.1 - b.height);
    Offset {
        x: max_left.min(0f32.max(b.left + x)) - b.left,
        y: max_top.min(min_top.max(b.top + y)) - b.top,
    }
}

/// `onDragStart`'s guard (Overlay.tsx:95): the primary button, not on one
/// of the header's buttons.
pub fn drag_starts(primary_button: bool, on_button: bool) -> bool {
    primary_button && !on_button
}

/// A drag in progress (`dragRef`): where the pointer and the offset
/// started, and the panel's un-dragged box.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Drag {
    pointer: (f32, f32),
    start: Offset,
    panel: PanelBox,
}

impl Drag {
    /// `onDragStart` (Overlay.tsx:94-107): `rect` is the panel's on-screen
    /// rect (its slot moved by `offset`).
    pub fn start(pointer: (f32, f32), offset: Offset, rect: PanelBox) -> Drag {
        Drag {
            pointer,
            start: offset,
            panel: PanelBox {
                left: rect.left - offset.x,
                top: rect.top - offset.y,
                ..rect
            },
        }
    }

    /// `onDragMove` (Overlay.tsx:108-118): the new offset.
    pub fn moved(&self, pointer: (f32, f32), viewport: (f32, f32), min_top: f32) -> Offset {
        clamp_offset(
            self.start.x + pointer.0 - self.pointer.0,
            self.start.y + pointer.1 - self.pointer.1,
            self.panel,
            viewport,
            min_top,
        )
    }
}

/// The window resized (Overlay.tsx:73-92): a dragged panel is pulled back
/// inside; an un-dragged one stays where the layout puts it.
pub fn on_resize(prev: Offset, rect: PanelBox, viewport: (f32, f32), min_top: f32) -> Offset {
    if !prev.is_moved() {
        return prev;
    }
    clamp_offset(
        prev.x,
        prev.y,
        PanelBox {
            left: rect.left - prev.x,
            top: rect.top - prev.y,
            ..rect
        },
        viewport,
        min_top,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_overlay_tsx_s() {
        let p = FrameProps::default();
        assert_eq!(p.width, 640.);
        assert!(p.dismiss_on_backdrop && p.backdrop);
        assert!(!p.minimizable && !p.draggable);
        assert_eq!(p.max_height_vh, 80.);
        assert_eq!(FrameProps::with_width(680.).width, 680.);
        assert!(FrameProps::with_width(680.).dismiss_on_backdrop);
    }

    #[test]
    fn escape_closes_only_while_dismiss_on_backdrop() {
        let mut p = FrameProps::default();
        assert!(p.escape_closes());
        // Without a backdrop Escape still closes (it only governs Escape).
        p.backdrop = false;
        assert!(p.escape_closes());
        p.dismiss_on_backdrop = false;
        assert!(!p.escape_closes());
    }

    #[test]
    fn the_backdrop_click_closes_only_with_a_backdrop_and_dismiss() {
        let mut p = FrameProps::default();
        assert!(p.backdrop_click_closes());
        p.dismiss_on_backdrop = false;
        assert!(!p.backdrop_click_closes());
        p.dismiss_on_backdrop = true;
        p.backdrop = false;
        assert!(!p.backdrop_click_closes());
        assert!(!p.layer_takes_pointer());
        assert!(FrameProps::default().layer_takes_pointer());
    }

    #[test]
    fn the_panel_is_at_most_92vw_and_max_height_vh_tall() {
        let p = FrameProps::with_width(680.);
        assert_eq!(p.panel_width(1440.), 680.);
        assert_eq!(p.panel_width(500.), 460.);
        assert_eq!(p.max_height(900.), 720.);
        let tall = FrameProps {
            max_height_vh: 88.,
            ..p
        };
        assert_eq!(tall.max_height(1000.), 880.);
        assert_eq!(top_offset(900.), 72.);
    }

    #[test]
    fn clamp_offset_keeps_the_panel_on_screen_below_the_title_bar() {
        let b = PanelBox {
            left: 400.,
            top: 72.,
            width: 520.,
            height: 300.,
        };
        let vp = (1320., 900.);
        // Inside: unchanged.
        assert_eq!(
            clamp_offset(10., 20., b, vp, 32.),
            Offset { x: 10., y: 20. }
        );
        // Off the left / top: stops at 0 / the title bar.
        assert_eq!(
            clamp_offset(-900., -900., b, vp, 32.),
            Offset { x: -400., y: -40. }
        );
        // Off the right / bottom: stops at the edge.
        assert_eq!(
            clamp_offset(900., 900., b, vp, 32.),
            Offset { x: 400., y: 528. }
        );
        // A panel wider / taller than the window pins to the top-left.
        let big = PanelBox {
            width: 2000.,
            height: 2000.,
            ..b
        };
        assert_eq!(
            clamp_offset(50., 50., big, vp, 32.),
            Offset { x: -400., y: -40. }
        );
    }

    #[test]
    fn drag_starts_on_the_primary_button_off_the_buttons() {
        assert!(drag_starts(true, false));
        assert!(!drag_starts(false, false));
        assert!(!drag_starts(true, true));
    }

    #[test]
    fn a_drag_moves_from_where_it_started_and_clamps() {
        let rect = PanelBox {
            left: 410.,
            top: 92.,
            width: 520.,
            height: 300.,
        };
        // Already moved by (10, 20): the slot is at (400, 72).
        let d = Drag::start((500., 100.), Offset { x: 10., y: 20. }, rect);
        assert_eq!(
            d.moved((530., 90.), (1320., 900.), 32.),
            Offset { x: 40., y: 10. }
        );
        assert_eq!(
            d.moved((-2000., -2000.), (1320., 900.), 32.),
            Offset { x: -400., y: -40. }
        );
    }

    #[test]
    fn a_resize_pulls_a_dragged_panel_back_in() {
        let rect = PanelBox {
            left: 900.,
            top: 72.,
            width: 400.,
            height: 300.,
        };
        // Un-dragged: left alone.
        assert_eq!(
            on_resize(Offset::default(), rect, (800., 600.), 32.),
            Offset::default()
        );
        // Dragged 500 right of a slot at 400: the window shrank to 800.
        let prev = Offset { x: 500., y: 0. };
        assert_eq!(
            on_resize(prev, rect, (800., 600.), 32.),
            Offset { x: 0., y: 0. }
        );
        assert!(!Offset::default().is_moved());
        assert!(Offset { x: 0., y: 1. }.is_moved());
    }
}
