//! CSS colors as sRGB, the way Chromium resolves them.
//!
//! [`parse`] reads the color syntaxes the tokens use (`#rgb` / `#rrggbb`
//! hex, legacy `rgb()` / `rgba()`, `oklch()`, `transparent`) into [`Rgba`]:
//! sRGB channels in 0..=1, **unclamped**. An `oklch()` color outside the
//! sRGB gamut (most of Tailwind's saturated steps) keeps channels below 0
//! or above 1, as Chromium's own conversion does (`rgb(from <c> r g b)`
//! serializes the same numbers). [`Rgba::to_rgba8`] is what Chromium
//! paints into an sRGB surface: each channel clipped to 0..=1 and rounded,
//! with no CSS gamut mapping (chroma reduction). That is also the value to
//! hand a UI toolkit that draws in sRGB.
//!
//! [`mix_oklab`] is `color-mix(in oklab, …)`, which Tailwind v4 emits for
//! every `/N` opacity modifier (`bg-red-500/10` is
//! `color-mix(in oklab, var(--color-red-500) 10%, transparent)`), and
//! [`with_opacity`] that common case.

/// An sRGB color with straight (not premultiplied) alpha. The channels are
/// not clamped: see the module docs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Rgba {
    pub const TRANSPARENT: Rgba = Rgba {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 0.0,
    };

    /// An opaque color from 8-bit channels (`#rrggbb`).
    pub fn from_rgb8(r: u8, g: u8, b: u8) -> Rgba {
        Rgba {
            r: f32::from(r) / 255.0,
            g: f32::from(g) / 255.0,
            b: f32::from(b) / 255.0,
            a: 1.0,
        }
    }

    /// What Chromium paints into an 8-bit sRGB surface: every channel
    /// clipped to 0..=1 and rounded to the nearest of 0..=255.
    pub fn to_rgba8(self) -> [u8; 4] {
        // `as u8` saturates: below 0 is 0, above 255 is 255.
        let q = |x: f32| (f64::from(x) * 255.0).round() as u8;
        [q(self.r), q(self.g), q(self.b), q(self.a)]
    }

    /// Whether every channel is inside the sRGB gamut (0..=1).
    pub fn in_gamut(self) -> bool {
        [self.r, self.g, self.b]
            .iter()
            .all(|c| (0.0..=1.0).contains(c))
    }
}

/// An OKLab color (`L` in 0..=1) with straight alpha.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Oklab {
    pub l: f64,
    pub a: f64,
    pub b: f64,
    pub alpha: f64,
}

fn to_linear(c: f64) -> f64 {
    let a = c.abs();
    if a < 0.04045 {
        c / 12.92
    } else {
        c.signum() * ((a + 0.055) / 1.055).powf(2.4)
    }
}

fn from_linear(c: f64) -> f64 {
    let a = c.abs();
    if a < 0.04045 / 12.92 {
        c * 12.92
    } else {
        c.signum() * (1.055 * a.powf(1.0 / 2.4) - 0.055)
    }
}

type M3 = [[f64; 3]; 3];

fn apply(m: &M3, v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2])
}

fn concat(a: &M3, b: &M3) -> M3 {
    [0, 1, 2].map(|i| [0, 1, 2].map(|j| a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]))
}

fn invert(m: &M3) -> M3 {
    let c = |i: usize, j: usize| {
        let (r0, r1, c0, c1) = ((i + 1) % 3, (i + 2) % 3, (j + 1) % 3, (j + 2) % 3);
        m[r0][c0] * m[r1][c1] - m[r0][c1] * m[r1][c0]
    };
    let det = m[0][0] * c(0, 0) + m[0][1] * c(0, 1) + m[0][2] * c(0, 2);
    [0, 1, 2].map(|i| [0, 1, 2].map(|j| c(j, i) / det))
}

/// The matrices Chromium converts with (`ui/gfx/color_conversions.cc`):
/// sRGB's gamut is Skia's `SkNamedGamut::kSRGB`, the ICC 16.16 fixed-point
/// matrix to XYZ D50, and OKLab is defined on XYZ D65, so every OKLab
/// conversion passes skcms's Bradford D65 to D50 adaptation. Using the
/// exact sRGB matrix instead moves channels by up to ~1e-4.
struct Matrices {
    srgb_to_xyz_d50: M3,
    xyz_d50_to_srgb: M3,
    d65_to_d50: M3,
    d50_to_d65: M3,
}

const XYZ_TO_LMS: M3 = [
    [
        0.819_022_443_216_431_9,
        0.361_906_256_280_122_1,
        -0.128_873_782_612_164_14,
    ],
    [
        0.032_983_667_198_027_1,
        0.929_286_846_896_554_6,
        0.036_144_668_169_998_44,
    ],
    [
        0.048_177_199_566_046_255,
        0.264_239_524_944_227_64,
        0.633_547_825_813_693_7,
    ],
];
const LMS_TO_XYZ: M3 = [
    [
        1.226_879_873_374_155_7,
        -0.557_814_996_555_481_3,
        0.281_391_050_177_215_83,
    ],
    [
        -0.040_575_762_624_313_72,
        1.112_286_829_397_059_4,
        -0.071_711_066_661_517_01,
    ],
    [
        -0.076_372_949_746_721_42,
        -0.421_493_323_962_791_4,
        1.586_924_024_427_241_8,
    ],
];
const OKLAB_TO_LMS: M3 = [
    [
        0.999_999_998_450_519_8,
        0.396_337_792_173_767_86,
        0.215_803_758_060_758_8,
    ],
    [
        1.000_000_008_881_760_8,
        -0.105_561_342_323_656_35,
        -0.063_854_174_771_705_9,
    ],
    [
        1.000_000_054_672_410_9,
        -0.089_484_182_094_965_76,
        -1.291_485_537_864_091_7,
    ],
];
const LMS_TO_OKLAB: M3 = [
    [0.210_454_255_3, 0.793_617_785, -0.004_072_046_8],
    [1.977_998_495_1, -2.428_592_205, 0.450_593_709_9],
    [0.025_904_037_1, 0.782_771_766_2, -0.808_675_766],
];

fn matrices() -> &'static Matrices {
    static M: std::sync::OnceLock<Matrices> = std::sync::OnceLock::new();
    M.get_or_init(|| {
        let fixed = |rows: [[u32; 3]; 3]| rows.map(|r| r.map(|v| f64::from(v) / 65536.0));
        let srgb_to_xyz_d50 = fixed([
            [0x6FA2, 0x6299, 0x24A0],
            [0x38F5, 0xB785, 0x0F84],
            [0x0390, 0x18DA, 0xB6CF],
        ]);
        // skcms_AdaptToXYZD50(0.3127, 0.3290): Bradford, to skcms's D50.
        let (wx, wy) = (0.3127f64, 0.3290f64);
        let src = [wx / wy, 1.0, (1.0 - wx - wy) / wy];
        let dst = [0.96422, 1.0, 0.82521];
        let to_lms: M3 = [
            [0.8951, 0.2664, -0.1614],
            [-0.7502, 1.7135, 0.0367],
            [0.0389, -0.0685, 1.0296],
        ];
        let from_lms: M3 = [
            [0.986_992_9, -0.147_054_3, 0.159_962_7],
            [0.432_305_3, 0.518_360_3, 0.049_291_2],
            [-0.008_528_7, 0.040_042_8, 0.968_486_7],
        ];
        let (sc, dc) = (apply(&to_lms, src), apply(&to_lms, dst));
        let scale: M3 = [
            [dc[0] / sc[0], 0.0, 0.0],
            [0.0, dc[1] / sc[1], 0.0],
            [0.0, 0.0, dc[2] / sc[2]],
        ];
        let d65_to_d50 = concat(&from_lms, &concat(&scale, &to_lms));
        Matrices {
            xyz_d50_to_srgb: invert(&srgb_to_xyz_d50),
            srgb_to_xyz_d50,
            d50_to_d65: invert(&d65_to_d50),
            d65_to_d50,
        }
    })
}

/// sRGB to OKLab, through XYZ D50 and D65 as Chromium converts.
pub fn srgb_to_oklab(c: Rgba) -> Oklab {
    let m = matrices();
    let linear = [c.r, c.g, c.b].map(|v| to_linear(f64::from(v)));
    let xyz = apply(&m.d50_to_d65, apply(&m.srgb_to_xyz_d50, linear));
    let lms = apply(&XYZ_TO_LMS, xyz).map(f64::cbrt);
    let [l, a, b] = apply(&LMS_TO_OKLAB, lms);
    Oklab {
        l,
        a,
        b,
        alpha: f64::from(c.a),
    }
}

/// OKLab to sRGB, unclamped.
pub fn oklab_to_srgb(c: Oklab) -> Rgba {
    let m = matrices();
    let lms = apply(&OKLAB_TO_LMS, [c.l, c.a, c.b]).map(|v| v * v * v);
    let linear = apply(
        &m.xyz_d50_to_srgb,
        apply(&m.d65_to_d50, apply(&LMS_TO_XYZ, lms)),
    );
    let [r, g, b] = linear.map(from_linear);
    Rgba {
        r: r as f32,
        g: g as f32,
        b: b as f32,
        a: c.alpha as f32,
    }
}

/// `oklch(L C H)` (`L` in 0..=1, `H` in degrees) to sRGB, unclamped.
pub fn oklch_to_srgb(l: f64, c: f64, h: f64, alpha: f64) -> Rgba {
    let rad = h.to_radians();
    oklab_to_srgb(Oklab {
        l,
        a: c * rad.cos(),
        b: c * rad.sin(),
        alpha,
    })
}

/// `color-mix(in oklab, a pa%, b pb%)`: premultiplied interpolation, with
/// the percentages normalized as CSS Color 5 says (a sum under 100% scales
/// the result's alpha down). `None` when both are 0%, which is invalid.
pub fn mix_oklab(a: Rgba, pa: f64, b: Rgba, pb: f64) -> Option<Rgba> {
    let sum = pa + pb;
    if sum <= 0.0 {
        return None;
    }
    let (wa, wb) = (pa / sum, pb / sum);
    let (x, y) = (srgb_to_oklab(a), srgb_to_oklab(b));
    let alpha = x.alpha * wa + y.alpha * wb;
    let mix = |p: f64, q: f64| {
        let v = p * x.alpha * wa + q * y.alpha * wb;
        if alpha == 0.0 { v } else { v / alpha }
    };
    let out = Oklab {
        l: mix(x.l, y.l),
        a: mix(x.a, y.a),
        b: mix(x.b, y.b),
        alpha: if sum < 100.0 {
            alpha * sum / 100.0
        } else {
            alpha
        },
    };
    Some(oklab_to_srgb(out))
}

/// Tailwind's `/pct` opacity modifier:
/// `color-mix(in oklab, <c> pct%, transparent)`.
pub fn with_opacity(c: Rgba, pct: f64) -> Rgba {
    mix_oklab(c, pct, Rgba::TRANSPARENT, 100.0 - pct).unwrap_or(Rgba::TRANSPARENT)
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn parse_hex(h: &str) -> Option<Rgba> {
    let d: Vec<u8> = h.bytes().map(hex_digit).collect::<Option<_>>()?;
    let (r, g, b, a) = match d.len() {
        3 => (d[0] * 17, d[1] * 17, d[2] * 17, 255),
        4 => (d[0] * 17, d[1] * 17, d[2] * 17, d[3] * 17),
        6 => (d[0] * 16 + d[1], d[2] * 16 + d[3], d[4] * 16 + d[5], 255),
        8 => (
            d[0] * 16 + d[1],
            d[2] * 16 + d[3],
            d[4] * 16 + d[5],
            d[6] * 16 + d[7],
        ),
        _ => return None,
    };
    Some(Rgba {
        a: f32::from(a) / 255.0,
        ..Rgba::from_rgb8(r, g, b)
    })
}

/// A CSS `<number>` or `<percentage>` (`pct_of` is what 100% means).
fn number(s: &str, pct_of: f64) -> Option<f64> {
    let s = s.trim();
    match s.strip_suffix('%') {
        Some(p) => p.parse::<f64>().ok().map(|v| v / 100.0 * pct_of),
        None => s.parse::<f64>().ok(),
    }
}

/// The arguments of `name(…)`, or `None` when `s` isn't that function.
fn args<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    s.strip_prefix(name)?.strip_prefix('(')?.strip_suffix(')')
}

/// Parses the color syntaxes the design tokens use. Legacy `rgb()` /
/// `rgba()` keeps alpha in 8 bits, as Chromium stores it (`0.35` is
/// 89/255), and its channels as written.
pub fn parse(text: &str) -> Option<Rgba> {
    let s = text.trim();
    if let Some(h) = s.strip_prefix('#') {
        return parse_hex(h);
    }
    if s.eq_ignore_ascii_case("transparent") {
        return Some(Rgba::TRANSPARENT);
    }
    if let Some(a) = args(s, "oklch") {
        let (lch, alpha) = match a.split_once('/') {
            Some((lch, alpha)) => (lch, number(alpha, 1.0)?),
            None => (a, 1.0),
        };
        let p: Vec<&str> = lch.split_whitespace().collect();
        let [l, c, h] = p[..] else { return None };
        return Some(oklch_to_srgb(
            number(l, 1.0)?,
            number(c, 0.4)?,
            number(h, 1.0)?,
            alpha,
        ));
    }
    if let Some(a) = args(s, "rgba").or_else(|| args(s, "rgb")) {
        let p: Vec<&str> = a.split(',').map(str::trim).collect();
        if !(3..=4).contains(&p.len()) {
            return None;
        }
        // The channels are all numbers (0..=255) or all percentages, kept
        // as floats.
        let pct = p[0].ends_with('%');
        if p[..3].iter().any(|v| v.ends_with('%') != pct) {
            return None;
        }
        let ch = |v: &str| number(v, 255.0).map(|n| (n / 255.0).clamp(0.0, 1.0) as f32);
        let alpha = match p.get(3) {
            Some(v) => number(v, 1.0)?.clamp(0.0, 1.0),
            None => 1.0,
        };
        return Some(Rgba {
            r: ch(p[0])?,
            g: ch(p[1])?,
            b: ch(p[2])?,
            a: ((alpha * 255.0).round() / 255.0) as f32,
        });
    }
    None
}
