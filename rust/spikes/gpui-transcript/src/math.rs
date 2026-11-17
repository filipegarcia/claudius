//! U05 prototype: LaTeX math with RaTeX (KaTeX's parser, layout rules and
//! fonts, ported to Rust; MIT). parse → layout → display list → SVG with the
//! KaTeX glyphs embedded as outlines → a GPUI image. The markdown plugins
//! claim `$…$` (inline, baseline-aligned) and `$$…$$` (block) nodes; the
//! layout runs in the TextView's background parse, not in the frame.

use std::sync::Arc;
use std::time::Instant;

use gpui_kit::component::text::{
    InlineElement, InlineRenderContext, MarkdownNode, MarkdownParseContext, MarkdownPlugin,
    markdown_ast as mdast,
};
use gpui_kit::*;
use ratex_layout::{LayoutOptions, layout, to_display_list};
use ratex_svg::{SvgOptions, render_to_svg};
use ratex_types::{Color, MathStyle};

/// KaTeX sets math at 1.21× the surrounding text.
pub const KATEX_SCALE: f32 = 1.21;
/// SVG images rasterize at 1 device px per SVG unit; render at 2× so the
/// formula is crisp on a Retina display.
const RASTER_SCALE: f64 = 2.0;

pub struct Rendered {
    pub image: Arc<Image>,
    /// Box size in CSS px at `em_px`.
    pub width: f32,
    pub height: f32,
    /// Distance from the top to the baseline.
    pub ascent: f32,
    pub micros: u128,
    pub svg_bytes: usize,
}

pub fn render(latex: &str, display: bool, em_px: f32, color: Hsla) -> Result<Rendered, String> {
    let t = Instant::now();
    let nodes = ratex_parser::parse(latex).map_err(|e| format!("{e:?}"))?;
    let rgb = color.to_rgb();
    let opts = LayoutOptions {
        style: if display {
            MathStyle::Display
        } else {
            MathStyle::Text
        },
        color: Color::new(rgb.r, rgb.g, rgb.b, rgb.a),
        ..Default::default()
    };
    let lbox = layout(&nodes, &opts);
    let list = to_display_list(&lbox);
    let svg = render_to_svg(
        &list,
        &SvgOptions {
            font_size: em_px as f64 * RASTER_SCALE,
            padding: 0.0,
            embed_glyphs: true,
            ..Default::default()
        },
    );
    let em = em_px;
    Ok(Rendered {
        width: (list.width as f32 * em).ceil(),
        height: ((list.height + list.depth) as f32 * em).ceil(),
        ascent: list.height as f32 * em,
        svg_bytes: svg.len(),
        image: Arc::new(Image::from_bytes(ImageFormat::Svg, svg.into_bytes())),
        micros: t.elapsed().as_micros(),
    })
}

pub fn element(r: &Rendered) -> AnyElement {
    img(r.image.clone())
        .w(px(r.width))
        .h(px(r.height))
        .flex_none()
        .into_any_element()
}

fn fallback(latex: &str, err: &str) -> AnyElement {
    div()
        .text_color(gpui_kit::red())
        .child(format!("math error in `{latex}`: {err}"))
        .into_any_element()
}

pub struct InlineMath {
    pub color: Hsla,
    pub text_px: f32,
}
pub struct BlockMath {
    pub color: Hsla,
    pub text_px: f32,
}

type Parsed = Result<Rendered, (String, String)>;

impl MarkdownPlugin for InlineMath {
    fn name(&self) -> &str {
        "math-inline"
    }
    fn parse(&self, node: &mdast::Node, _: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
        let mdast::Node::InlineMath(m) = node else {
            return None;
        };
        let r: Parsed = render(&m.value, false, self.text_px * KATEX_SCALE, self.color)
            .map_err(|e| (m.value.clone(), e));
        Some(MarkdownNode::new("math-inline", r).text(m.value.clone()))
    }
    fn render(&self, node: &MarkdownNode, _: &mut Window, _: &mut App) -> impl IntoElement {
        match node.data::<Parsed>() {
            Some(Ok(r)) => element(r),
            Some(Err((src, e))) => fallback(src, e),
            None => div().into_any_element(),
        }
    }
    fn render_inline(
        &self,
        node: &MarkdownNode,
        _: &InlineRenderContext,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<InlineElement> {
        let ascent = match node.data::<Parsed>() {
            Some(Ok(r)) => Some(r.ascent),
            _ => None,
        };
        let el = InlineElement::new(self.render(node, window, cx));
        Some(match ascent {
            Some(a) => el.with_baseline(px(a)),
            None => el,
        })
    }
}

impl MarkdownPlugin for BlockMath {
    fn is_block(&self) -> bool {
        true
    }
    fn name(&self) -> &str {
        "math-block"
    }
    fn parse(&self, node: &mdast::Node, _: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
        let mdast::Node::Math(m) = node else {
            return None;
        };
        let r: Parsed = render(&m.value, true, self.text_px * KATEX_SCALE, self.color)
            .map_err(|e| (m.value.clone(), e));
        Some(MarkdownNode::new("math-block", r).text(m.value.clone()))
    }
    fn render(&self, node: &MarkdownNode, _: &mut Window, _: &mut App) -> impl IntoElement {
        let inner = match node.data::<Parsed>() {
            Some(Ok(r)) => element(r),
            Some(Err((src, e))) => fallback(src, e),
            None => div().into_any_element(),
        };
        div().w_full().flex().justify_center().py_2().child(inner)
    }
}

/// Formulas for the gallery and the KaTeX comparison (`--math-report`).
pub const FORMULAS: &[&str] = &[
    r"e^{i\pi} + 1 = 0",
    r"\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}",
    r"\sum_{k=1}^{n} k^2 = \frac{n(n+1)(2n+1)}{6}",
    r"\begin{pmatrix} a & b \\ c & d \end{pmatrix}^{-1} = \frac{1}{ad-bc}\begin{pmatrix} d & -b \\ -c & a \end{pmatrix}",
    r"f(x) = \begin{cases} x^2 & x \ge 0 \\ -x & x < 0 \end{cases}",
    r"\nabla \times \mathbf{B} = \mu_0 \mathbf{J} + \mu_0 \varepsilon_0 \frac{\partial \mathbf{E}}{\partial t}",
    r"\left( \sum_{i=1}^n a_i b_i \right)^2 \le \left( \sum_{i=1}^n a_i^2 \right)\left( \sum_{i=1}^n b_i^2 \right)",
    r"\mathbb{P}(A \mid B) = \frac{\mathbb{P}(B \mid A)\,\mathbb{P}(A)}{\mathbb{P}(B)}",
];
