//! `image-size` 2.0.2's `imageSize(buffer)`, the width and height
//! `asset-ingest.ts` stores for an image (`safeImageSize`): the type is
//! found from the bytes (the first-byte shortcut, then every validator in
//! the package's order), never from the declared media type. Every
//! detector of the package is here (BMP, CUR, DDS, GIF, HEIF, ICNS, ICO,
//! J2C, JP2, JPEG, JXL, the JXL codestream, KTX, PNG, PNM, PSD, SVG, TGA,
//! TIFF, WebP), step for step, including where it gives up.
//!
//! Only the dimensions are kept: `None` is JS `undefined` (an ICO entry or
//! an ICNS type it doesn't know, a missing SVG length), and a dimension can
//! be any JS number (an SVG's `NaN` or `Infinity`, a HEIF crop below 0).
//! [`image_size`] is `Err` wherever the package throws: no type, a
//! validator or calculator that rejects the bytes, or a read past the end.
//!
//! Reads keep the package's two kinds: `input[i]` past the end is
//! `undefined` (and `undefined & 15` is 0), while its `DataView` reads see
//! the whole underlying buffer, not just the sub-array, and throw only past
//! the end of that. Here the buffer is the decoded bytes. In TS a decoded
//! image under 4 KiB sits in Node's shared 8 KiB `Buffer` pool, so a
//! truncated one reads whatever bytes follow it in the pool; Rust treats
//! those reads as past the end.
//!
//! Three loops of the package never end on a zero-size entry (a HEIF
//! `ispe` box, a JXL `jxlp` box, an ICNS entry): V8 grows an array until it
//! runs out of memory. Rust stops there with `Err`.

/// The package threw (or would never return).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Thrown;

type R<T> = Result<T, Thrown>;

/// A JS dimension: `None` is `undefined`.
pub type Dim = Option<f64>;

/// `{ width, height }` of the image `imageSize` picked.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Size {
    pub width: Dim,
    pub height: Dim,
}

/// A `Uint8Array` view: `off..off + len` of `buf`, the whole `ArrayBuffer`.
#[derive(Clone, Copy)]
struct V<'a> {
    buf: &'a [u8],
    off: usize,
    len: usize,
}

impl<'a> V<'a> {
    fn new(buf: &'a [u8]) -> V<'a> {
        V {
            buf,
            off: 0,
            len: buf.len(),
        }
    }

    fn bytes(&self) -> &'a [u8] {
        &self.buf[self.off..self.off + self.len]
    }

    /// `input[i]`: `undefined` past the end.
    fn at(&self, i: usize) -> Option<u8> {
        (i < self.len).then(|| self.buf[self.off + i])
    }

    /// `input[i] & mask` with JS's `undefined` → 0.
    fn at0(&self, i: usize) -> u32 {
        u32::from(self.at(i).unwrap_or(0))
    }

    /// `input.slice(start, end)` (a `subarray`: clamped, shares the buffer).
    fn slice(&self, start: f64, end: Option<f64>) -> V<'a> {
        let clamp = |x: f64| -> usize {
            if x.is_nan() || x <= 0.0 {
                0
            } else if x >= self.len as f64 {
                self.len
            } else {
                x as usize
            }
        };
        let s = clamp(start);
        let e = end.map_or(self.len, clamp).max(s);
        V {
            buf: self.buf,
            off: self.off + s,
            len: e - s,
        }
    }

    /// `new DataView(input.buffer, input.byteOffset + o)` read of `n` bytes.
    fn dv(&self, o: usize, n: usize) -> R<&'a [u8]> {
        let at = self.off.checked_add(o).ok_or(Thrown)?;
        let end = at.checked_add(n).ok_or(Thrown)?;
        if end > self.buf.len() {
            return Err(Thrown);
        }
        Ok(&self.buf[at..end])
    }

    fn u16le(&self, o: usize) -> R<f64> {
        let b = self.dv(o, 2)?;
        Ok(f64::from(u16::from_le_bytes([b[0], b[1]])))
    }
    fn u16be(&self, o: usize) -> R<f64> {
        let b = self.dv(o, 2)?;
        Ok(f64::from(u16::from_be_bytes([b[0], b[1]])))
    }
    fn i16le(&self, o: usize) -> R<i32> {
        let b = self.dv(o, 2)?;
        Ok(i32::from(i16::from_le_bytes([b[0], b[1]])))
    }
    fn u24le(&self, o: usize) -> R<f64> {
        // `getUint16(0, true) + (getUint8(2) << 16)`: the three bytes are
        // checked as two reads.
        let lo = self.u16le(o)?;
        let hi = self.dv(o, 3)?[2];
        Ok(lo + f64::from(u32::from(hi) << 16))
    }
    fn i32le(&self, o: usize) -> R<f64> {
        let b = self.dv(o, 4)?;
        Ok(f64::from(i32::from_le_bytes([b[0], b[1], b[2], b[3]])))
    }
    fn u32le(&self, o: usize) -> R<f64> {
        let b = self.dv(o, 4)?;
        Ok(f64::from(u32::from_le_bytes([b[0], b[1], b[2], b[3]])))
    }
    fn u32be(&self, o: usize) -> R<f64> {
        let b = self.dv(o, 4)?;
        Ok(f64::from(u32::from_be_bytes([b[0], b[1], b[2], b[3]])))
    }
    /// `Number(getBigUint64(0, !isBigEndian))`.
    fn u64(&self, o: usize, big_endian: bool) -> R<f64> {
        let b: [u8; 8] = self.dv(o, 8)?.try_into().expect("8 bytes");
        Ok(if big_endian {
            u64::from_be_bytes(b)
        } else {
            u64::from_le_bytes(b)
        } as f64)
    }
    /// `readUInt(input, bits, offset, isBigEndian)`.
    fn uint(&self, bits: u32, o: usize, big_endian: bool) -> R<f64> {
        match (bits, big_endian) {
            (16, false) => self.u16le(o),
            (16, true) => self.u16be(o),
            (32, false) => self.u32le(o),
            _ => self.u32be(o),
        }
    }

    /// `toUTF8String(input, start, end) === lit` for an ASCII `lit`: a
    /// `TextDecoder` result equals it exactly when the raw bytes do.
    fn is(&self, start: usize, end: usize, lit: &[u8]) -> bool {
        self.slice(start as f64, Some(end as f64)).bytes() == lit
    }

    /// `toUTF8String(input, start, end)`: lossy UTF-8, a leading BOM dropped.
    fn text(&self, start: usize, end: Option<usize>) -> String {
        let b = self.slice(start as f64, end.map(|e| e as f64)).bytes();
        let b = b.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(b);
        String::from_utf8_lossy(b).into_owned()
    }

    /// `toHexString(input, start, end) === hex`.
    fn hex_is(&self, start: usize, end: usize, hex: &[u8]) -> bool {
        self.slice(start as f64, Some(end as f64)).bytes() == hex
    }
}

/// A box of the ISO base media file format (`readBox`).
#[derive(Clone, Copy)]
struct BoxAt {
    offset: f64,
    size: f64,
}

fn read_box(input: &V, offset: f64, name: &[u8; 4]) -> R<Option<(BoxAt, bool)>> {
    if input.len as f64 - offset < 4.0 {
        return Ok(None);
    }
    let o = offset as usize;
    let size = input.u32be(o)?;
    if input.len as f64 - offset < size {
        return Ok(None);
    }
    Ok(Some((BoxAt { offset, size }, input.is(o + 4, o + 8, name))))
}

/// `findBox(input, name, offset)`: walk the boxes from `offset`.
fn find_box(input: &V, name: &[u8; 4], mut offset: f64) -> R<Option<BoxAt>> {
    while offset < input.len as f64 {
        let Some((b, matches)) = read_box(input, offset, name)? else {
            break;
        };
        if matches {
            return Ok(Some(b));
        }
        offset += if b.size > 0.0 { b.size } else { 8.0 };
    }
    Ok(None)
}

/// What a calculator returns: the dimensions and, for a multi-image file,
/// every image's (`images`).
struct Calc {
    width: Dim,
    height: Dim,
    images: Option<Vec<(Dim, Dim)>>,
}

impl Calc {
    fn wh(width: f64, height: f64) -> R<Calc> {
        Ok(Calc {
            width: Some(width),
            height: Some(height),
            images: None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Type {
    Bmp,
    Cur,
    Dds,
    Gif,
    Heif,
    Icns,
    Ico,
    J2c,
    Jp2,
    Jpg,
    Jxl,
    JxlStream,
    Ktx,
    Png,
    Pnm,
    Psd,
    Svg,
    Tga,
    Tiff,
    Webp,
}

/// `typeHandlers`' key order, which `types.find` walks.
const TYPES: [Type; 20] = [
    Type::Bmp,
    Type::Cur,
    Type::Dds,
    Type::Gif,
    Type::Heif,
    Type::Icns,
    Type::Ico,
    Type::J2c,
    Type::Jp2,
    Type::Jpg,
    Type::Jxl,
    Type::JxlStream,
    Type::Ktx,
    Type::Png,
    Type::Pnm,
    Type::Psd,
    Type::Svg,
    Type::Tga,
    Type::Tiff,
    Type::Webp,
];

/// `firstBytes`.
fn first_byte_type(b: Option<u8>) -> Option<Type> {
    Some(match b? {
        0 => Type::Heif,
        56 => Type::Psd,
        66 => Type::Bmp,
        68 => Type::Dds,
        71 => Type::Gif,
        73 | 77 => Type::Tiff,
        82 => Type::Webp,
        105 => Type::Icns,
        137 => Type::Png,
        255 => Type::Jpg,
        _ => return None,
    })
}

fn validate(t: Type, input: &V) -> R<bool> {
    Ok(match t {
        Type::Bmp => input.is(0, 2, b"BM"),
        Type::Cur | Type::Ico => {
            let reserved = input.u16le(0)?;
            let count = input.u16le(4)?;
            if reserved != 0.0 || count == 0.0 {
                return Ok(false);
            }
            input.u16le(2)? == if t == Type::Ico { 1.0 } else { 2.0 }
        }
        Type::Dds => input.u32le(0)? == 542_327_876.0,
        // `/^GIF8[79]a/` on the first six bytes.
        Type::Gif => {
            let b = input.slice(0.0, Some(6.0)).bytes();
            b.len() == 6 && &b[..4] == b"GIF8" && (b[4] == b'7' || b[4] == b'9') && b[5] == b'a'
        }
        Type::Heif => {
            if !input.is(4, 8, b"ftyp") {
                return Ok(false);
            }
            let Some(ftyp) = find_box(input, b"ftyp", 0.0)? else {
                return Ok(false);
            };
            let o = ftyp.offset as usize;
            let brand = input.slice((o + 8) as f64, Some((o + 12) as f64)).bytes();
            matches!(
                brand,
                b"avif" | b"mif1" | b"msf1" | b"heic" | b"heix" | b"hevc" | b"hevx"
            )
        }
        Type::Icns => input.is(0, 4, b"icns"),
        Type::J2c => input.u32be(0)? == 4_283_432_785.0,
        Type::Jp2 => box_brand(input, b"jP  ", b"jp2 ")?,
        Type::Jpg => input.hex_is(0, 2, &[0xff, 0xd8]),
        Type::Jxl => box_brand(input, b"JXL ", b"jxl ")?,
        Type::JxlStream => input.hex_is(0, 2, &[0xff, 0x0a]),
        Type::Ktx => input.is(1, 7, b"KTX 11") || input.is(1, 7, b"KTX 20"),
        Type::Png => {
            if !input.is(1, 8, b"PNG\r\n\x1a\n") {
                return Ok(false);
            }
            let ihdr = if input.is(12, 16, b"CgBI") {
                input.is(28, 32, b"IHDR")
            } else {
                input.is(12, 16, b"IHDR")
            };
            if !ihdr {
                return Err(Thrown); // "Invalid PNG"
            }
            true
        }
        Type::Pnm => matches!(
            input.slice(0.0, Some(2.0)).bytes(),
            b"P1" | b"P2" | b"P3" | b"P4" | b"P5" | b"P6" | b"P7" | b"PF"
        ),
        Type::Psd => input.is(0, 4, b"8BPS"),
        Type::Svg => svg_root(&input.text(0, Some(1000))).is_some(),
        Type::Tga => input.u16le(0)? == 0.0 && input.u16le(4)? == 0.0,
        Type::Tiff => {
            let sig = input.slice(0.0, Some(4.0)).bytes();
            matches!(
                sig,
                [0x49, 0x49, 0x2a, 0x00]
                    | [0x4d, 0x4d, 0x00, 0x2a]
                    | [0x49, 0x49, 0x2b, 0x00]
                    | [0x4d, 0x4d, 0x00, 0x2b]
            )
        }
        Type::Webp => {
            input.is(0, 4, b"RIFF") && input.is(8, 12, b"WEBP") && input.is(12, 15, b"VP8")
        }
    })
}

/// JP2 / JXL: the box type at 4..8, then the `ftyp` brand.
fn box_brand(input: &V, kind: &[u8], brand: &[u8]) -> R<bool> {
    if !input.is(4, 8, kind) {
        return Ok(false);
    }
    let Some(ftyp) = find_box(input, b"ftyp", 0.0)? else {
        return Ok(false);
    };
    let o = ftyp.offset as usize;
    Ok(input.is(o + 8, o + 12, brand))
}

fn calculate(t: Type, input: &V) -> R<Calc> {
    match t {
        Type::Bmp => Calc::wh(input.u32le(18)?, input.i32le(22)?.abs()),
        Type::Cur | Type::Ico => ico(input),
        Type::Dds => {
            let height = input.u32le(12)?;
            Calc::wh(input.u32le(16)?, height)
        }
        Type::Gif => {
            let height = input.u16le(8)?;
            Calc::wh(input.u16le(6)?, height)
        }
        Type::Heif => heif(input),
        Type::Icns => icns(input),
        Type::J2c => {
            let height = input.u32be(12)?;
            Calc::wh(input.u32be(8)?, height)
        }
        Type::Jp2 => {
            let ihdr = match find_box(input, b"jp2h", 0.0)? {
                Some(jp2h) => find_box(input, b"ihdr", jp2h.offset + 8.0)?,
                None => None,
            };
            let ihdr = ihdr.ok_or(Thrown)?; // "Unsupported JPEG 2000 format"
            let o = ihdr.offset as usize;
            let height = input.u32be(o + 8)?;
            Calc::wh(input.u32be(o + 12)?, height)
        }
        Type::Jpg => jpg(input),
        Type::Jxl => {
            let stream = jxl_codestream(input)?.ok_or(Thrown)?;
            let (width, height) = jxl_stream(&V::new(&stream))?;
            Calc::wh(width, height)
        }
        Type::JxlStream => {
            let (width, height) = jxl_stream(input)?;
            Calc::wh(width, height)
        }
        Type::Ktx => {
            let offset = if input.at(5) == Some(49) { 36 } else { 20 };
            let height = input.u32le(offset + 4)?;
            Calc::wh(input.u32le(offset)?, height)
        }
        Type::Png => {
            if input.is(12, 16, b"CgBI") {
                let height = input.u32be(36)?;
                Calc::wh(input.u32be(32)?, height)
            } else {
                let height = input.u32be(20)?;
                Calc::wh(input.u32be(16)?, height)
            }
        }
        Type::Pnm => pnm(input),
        Type::Psd => {
            let height = input.u32be(14)?;
            Calc::wh(input.u32be(18)?, height)
        }
        Type::Svg => svg(input),
        Type::Tga => {
            let height = input.u16le(14)?;
            Calc::wh(input.u16le(12)?, height)
        }
        Type::Tiff => tiff(input),
        Type::Webp => webp(input),
    }
}

/// ICO / CUR: the first entry, and every entry when there are several.
fn ico(input: &V) -> R<Calc> {
    let count = input.u16le(4)? as usize;
    // `value === 0 ? 256 : value`, `undefined` past the end.
    let entry = |i: usize| -> (Dim, Dim) {
        let o = 6 + i * 16;
        let size = |v: Option<u8>| v.map(|b| if b == 0 { 256.0 } else { f64::from(b) });
        (size(input.at(o)), size(input.at(o + 1)))
    };
    let (width, height) = entry(0);
    if count == 1 {
        return Ok(Calc {
            width,
            height,
            images: None,
        });
    }
    Ok(Calc {
        width,
        height,
        images: Some((0..count).map(entry).collect()),
    })
}

fn heif(input: &V) -> R<Calc> {
    let meta = find_box(input, b"meta", 0.0)?;
    let iprp = match meta {
        Some(m) => find_box(input, b"iprp", m.offset + 12.0)?,
        None => None,
    };
    let ipco = match iprp {
        Some(p) => find_box(input, b"ipco", p.offset + 8.0)?,
        None => None,
    };
    let ipco = ipco.ok_or(Thrown)?; // "Invalid HEIF, no ipco box found"
    let end = ipco.offset + ipco.size;
    let mut images: Vec<(Dim, Dim)> = Vec::new();
    let mut current = ipco.offset + 8.0;
    while current < end {
        let Some(ispe) = find_box(input, b"ispe", current)? else {
            break;
        };
        let o = ispe.offset as usize;
        let raw_width = input.u32be(o + 12)?;
        let raw_height = input.u32be(o + 16)?;
        let clap = find_box(input, b"clap", current)?;
        let mut width = raw_width;
        if let Some(clap) = clap.filter(|c| c.offset < end) {
            let crop_right = input.u32be(clap.offset as usize + 12)?;
            width = raw_width - crop_right;
        }
        images.push((Some(width), Some(raw_height)));
        let next = ispe.offset + ispe.size;
        if next == current {
            // An empty `ispe` box at `current`, found again and again: TS
            // never returns.
            return Err(Thrown);
        }
        current = next;
    }
    let (width, height) = *images.first().ok_or(Thrown)?; // "no sizes found"
    Ok(Calc {
        width,
        height,
        images: (images.len() > 1).then_some(images),
    })
}

/// `ICON_TYPE_SIZE`.
fn icns_size(t: &[u8]) -> Dim {
    Some(match t {
        b"ICON" | b"ICN#" => 32.0,
        b"icm#" | b"icm4" | b"icm8" | b"ics#" | b"ics4" | b"ics8" | b"is32" | b"s8mk" | b"icp4" => {
            16.0
        }
        b"icl4" | b"icl8" | b"il32" | b"l8mk" | b"icp5" | b"ic11" | b"ic12" => 32.0,
        b"ich4" | b"ich8" | b"ih32" | b"h8mk" => 48.0,
        b"icp6" => 64.0,
        b"it32" | b"t8mk" | b"ic07" => 128.0,
        b"ic08" | b"ic13" => 256.0,
        b"ic09" | b"ic14" => 512.0,
        b"ic10" => 1024.0,
        _ => return None,
    })
}

fn icns(input: &V) -> R<Calc> {
    let file_length = input.u32be(4)?;
    let mut offset = 8.0;
    let mut images: Vec<(Dim, Dim)> = Vec::new();
    while offset < file_length && offset < input.len as f64 {
        let o = offset as usize;
        // `toUTF8String` of the 4 type bytes: a key of the table only when
        // the bytes spell it.
        let kind = input.slice(offset, Some(offset + 4.0)).bytes();
        let length = input.u32be(o + 4)?;
        let size = icns_size(kind);
        images.push((size, size));
        if length == 0.0 {
            return Err(Thrown); // an endless loop in TS
        }
        offset += length;
    }
    let (width, height) = *images.first().ok_or(Thrown)?; // "Invalid ICNS, no sizes found"
    Ok(Calc {
        width,
        height,
        images: (images.len() > 1).then_some(images),
    })
}

fn jpg(whole: &V) -> R<Calc> {
    let mut input = whole.slice(4.0, None);
    while input.len > 0 {
        let i = input.u16be(0)? as usize;
        if i > input.len {
            return Err(Thrown); // "Corrupt JPG, exceeded buffer limits"
        }
        if input.at(i) != Some(255) {
            input = input.slice(1.0, None);
            continue;
        }
        // `isEXIF` → `validateExifBlock`: the orientation it reads isn't
        // kept, and none of its reads can change the outcome, so they are
        // left out. The block is `input[2..i]` and needs `i >= 10` to hold
        // a byte order. Every read of it ends by `input[max(18, i + 4)]`:
        // the entry count at 16..18, and an IFD entry only reads on while
        // its tag (274), format (3) and count (1) miss the `0xFF` at
        // `input[i]`. A size read, here or in a later segment, ends at
        // `input[i + 9]` or further, and `input` always runs to the end of
        // the buffer: when one of those reads would throw, no size could
        // be read anyway.
        let next = input.at(i + 1);
        if matches!(next, Some(192..=194)) {
            let height = input.u16be(i + 5)?;
            let width = input.u16be(i + 7)?;
            return Calc::wh(width, height);
        }
        input = input.slice((i + 2) as f64, None);
    }
    Err(Thrown) // "Invalid JPG, no size found"
}

/// `BitReader` (little-endian), starting past the 2-byte signature.
struct Bits<'a> {
    input: V<'a>,
    byte: usize,
    bit: u32,
}

impl Bits<'_> {
    fn get(&mut self, length: u32) -> R<u32> {
        let mut result: u32 = 0;
        let mut read = 0;
        while read < length {
            let current = u32::from(self.input.at(self.byte).ok_or(Thrown)?); // "Reached end of input"
            let left = 8 - self.bit;
            let take = (length - read).min(left);
            let mask = (1u32 << take) - 1;
            result |= ((current >> self.bit) & mask) << read;
            read += take;
            self.bit += take;
            if self.bit == 8 {
                self.byte += 1;
                self.bit = 0;
            }
        }
        Ok(result)
    }
}

/// `JXLStream.calculate`: the size header of a JPEG XL codestream.
fn jxl_stream(input: &V) -> R<(f64, f64)> {
    let mut r = Bits {
        input: *input,
        byte: 2,
        bit: 0,
    };
    let dimension = |r: &mut Bits, small: bool| -> R<f64> {
        if small {
            return Ok(8.0 * (1.0 + f64::from(r.get(5)?)));
        }
        let class = r.get(2)? as usize;
        let extra = [9, 13, 18, 30][class];
        Ok(1.0 + f64::from(r.get(extra)?))
    };
    let small = r.get(1)? == 1;
    let height = dimension(&mut r, small)?;
    let mode = r.get(3)?;
    let width = if small && mode == 0 {
        8.0 * (1.0 + f64::from(r.get(5)?))
    } else if mode == 0 {
        dimension(&mut r, false)?
    } else {
        let ratios = [1.0, 1.2, 4.0 / 3.0, 1.5, 16.0 / 9.0, 5.0 / 4.0, 2.0];
        (height * ratios[mode as usize - 1]).floor()
    };
    Ok((width, height))
}

/// `extractCodestream`: the `jxlc` box, else the `jxlp` boxes joined.
fn jxl_codestream(input: &V) -> R<Option<Vec<u8>>> {
    if let Some(jxlc) = find_box(input, b"jxlc", 0.0)? {
        let s = input.slice(jxlc.offset + 8.0, Some(jxlc.offset + jxlc.size));
        return Ok(Some(s.bytes().to_vec()));
    }
    let mut parts: Vec<&[u8]> = Vec::new();
    let mut offset = 0.0;
    while offset < input.len as f64 {
        let Some(jxlp) = find_box(input, b"jxlp", offset)? else {
            break;
        };
        parts.push(
            input
                .slice(jxlp.offset + 12.0, Some(jxlp.offset + jxlp.size))
                .bytes(),
        );
        if jxlp.size == 0.0 {
            return Err(Thrown); // an endless loop in TS
        }
        offset = jxlp.offset + jxlp.size;
    }
    Ok((!parts.is_empty()).then(|| parts.concat()))
}

fn pnm(input: &V) -> R<Calc> {
    let pam = input.slice(0.0, Some(2.0)).bytes() == b"P7";
    let text = input.text(3, None);
    let lines = split_newline_runs(&text);
    if pam {
        // `size.width` / `size.height`: `undefined` (NaN here) until set.
        let mut width = f64::NAN;
        let mut height = f64::NAN;
        let truthy = |x: f64| x != 0.0 && !x.is_nan();
        for line in lines {
            let first = line.encode_utf16().next();
            if line.encode_utf16().count() > 16 || first.is_some_and(|u| u > 128) {
                continue;
            }
            let mut parts = line.split(' ');
            let key = parts.next().unwrap_or("");
            let value = parts.next().unwrap_or("");
            if !key.is_empty() && !value.is_empty() {
                let n = claudius_agent::js::parse_int(value);
                match key.to_lowercase().as_str() {
                    "height" => height = n,
                    "width" => width = n,
                    _ => {}
                }
            }
            if truthy(height) && truthy(width) {
                break;
            }
        }
        if truthy(height) && truthy(width) {
            return Calc::wh(width, height);
        }
        return Err(Thrown); // "Invalid PAM"
    }
    let mut dims: Vec<&str> = Vec::new();
    for line in lines {
        if line.starts_with('#') {
            continue;
        }
        dims = line.split(' ').collect();
        break;
    }
    if dims.len() == 2 {
        let height = claudius_agent::js::parse_int(dims[1]);
        return Calc::wh(claudius_agent::js::parse_int(dims[0]), height);
    }
    Err(Thrown) // "Invalid PNM"
}

/// `text.split(/[\r\n]+/)`: each run of CR / LF is one separator.
fn split_newline_runs(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '\r' || c == '\n' {
            out.push(&text[start..i]);
            let mut end = i + 1;
            while let Some(&(j, d)) = chars.peek() {
                if d != '\r' && d != '\n' {
                    break;
                }
                end = j + 1;
                chars.next();
            }
            start = end;
        }
    }
    out.push(&text[start..]);
    out
}

/// JS `\s`.
fn js_space(c: char) -> bool {
    claudius_agent::js::is_whitespace(c)
}

/// `svgReg.exec(text)?.[0]`: `<svg\s([^>"']|"[^"]*"|'[^']*')*>`, the
/// leftmost match. The alternatives start on different characters, so the
/// backtracking engine's first match is this scan's.
fn svg_root(text: &str) -> Option<&str> {
    let mut from = 0;
    while let Some(at) = text[from..].find("<svg").map(|i| from + i) {
        from = at + 1;
        let rest = &text[at + 4..];
        let Some(ws) = rest.chars().next().filter(|c| js_space(*c)) else {
            continue;
        };
        let mut i = at + 4 + ws.len_utf8();
        // `(...)*` then `>`. A quote that never closes ends the run; the
        // engine then backs off one item at a time and finds no `>` (the
        // items before were not `>`), so this start fails.
        while let Some(c) = text[i..].chars().next() {
            match c {
                '>' => return Some(&text[at..=i]),
                '"' | '\'' => match text[i + 1..].find(c) {
                    Some(j) => i += 1 + j + 1,
                    None => break,
                },
                c => i += c.len_utf8(),
            }
        }
    }
    None
}

/// `\s<name>=(['"])([^%]+?)\1`: the value of the first match.
fn svg_attr<'a>(
    root: &'a str,
    name: &str,
    case_insensitive: bool,
    any_but_newline: bool,
) -> Option<&'a str> {
    let b = root.as_bytes();
    let mut i = 0;
    while i < root.len() {
        let Some(c) = root[i..].chars().next() else {
            break;
        };
        let after_space = i + c.len_utf8();
        if js_space(c) {
            let key_end = after_space + name.len();
            let key_ok = root.get(after_space..key_end).is_some_and(|k| {
                if case_insensitive {
                    k.eq_ignore_ascii_case(name)
                } else {
                    k == name
                }
            });
            if key_ok && b.get(key_end) == Some(&b'=') {
                if let Some(&q) = b.get(key_end + 1).filter(|q| **q == b'"' || **q == b'\'') {
                    let start = key_end + 2;
                    // The lazy `+?` stops at the first closing quote with at
                    // least one character before it; a character the class
                    // refuses ends the attempt.
                    let mut j = start;
                    while let Some(ch) = root[j..].chars().next() {
                        let refused = if any_but_newline {
                            matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
                        } else {
                            ch == '%'
                        };
                        if ch as u32 == u32::from(q) && j > start {
                            return Some(&root[start..j]);
                        }
                        if refused {
                            break;
                        }
                        j += ch.len_utf8();
                    }
                }
            }
        }
        i = after_space;
    }
    None
}

/// `parseLength`: `^([0-9.]+(?:e\d+)?)(in|cm|em|ex|m|mm|pc|pt|px)?$`, the
/// number times the unit, `Math.round`ed; `None` when it doesn't match.
fn parse_length(len: Option<&str>) -> Dim {
    // `unitsReg.exec(undefined)` tests the string "undefined".
    let len = len.unwrap_or("undefined");
    let b = len.as_bytes();
    let num_end = b
        .iter()
        .take_while(|c| c.is_ascii_digit() || **c == b'.')
        .count();
    if num_end == 0 {
        return None;
    }
    // Greedy `[0-9.]+`, then an optional `e\d+`, then an optional unit, then
    // the end. Backtracking into `[0-9.]+` can't help: what follows it must
    // start with `e` or a unit letter, never a digit or a dot.
    let units: [(&str, f64); 9] = [
        ("in", 96.0),
        ("cm", 96.0 / 2.54),
        ("em", 16.0),
        ("ex", 8.0),
        ("m", 96.0 / 2.54 * 100.0),
        ("mm", 96.0 / 2.54 / 10.0),
        ("pc", 96.0 / 72.0 / 12.0),
        ("pt", 96.0 / 72.0),
        ("px", 1.0),
    ];
    let unit_of = |rest: &str| -> Option<f64> {
        if rest.is_empty() {
            return Some(1.0);
        }
        units.iter().find(|(u, _)| *u == rest).map(|(_, f)| *f)
    };
    let try_with = |num: &str, rest: &str| -> Dim {
        let factor = unit_of(rest)?;
        Some(js_round(claudius_agent::js::to_number(num) * factor))
    };
    let rest = &len[num_end..];
    // With the exponent group.
    if let Some(e) = rest.strip_prefix('e') {
        let digits = e.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 {
            let end = num_end + 1 + digits;
            if let Some(v) = try_with(&len[..end], &len[end..]) {
                return Some(v);
            }
        }
    }
    try_with(&len[..num_end], rest)
}

/// `Math.round`.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    let f = x.floor();
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    // `Math.round(-0.4)` is `-0`.
    if r == 0.0 && x < 0.0 { -0.0 } else { r }
}

fn truthy_dim(d: Option<Dim>) -> bool {
    matches!(d, Some(Some(x)) if x != 0.0 && !x.is_nan())
}

fn svg(input: &V) -> R<Calc> {
    let text = input.text(0, None);
    let root = svg_root(&text).ok_or(Thrown)?; // "Invalid SVG"
    // `width && parseLength(width[2])`: `None` is no match (`null`),
    // `Some(None)` a length it can't read (`undefined`).
    let width: Option<Dim> = svg_attr(root, "width", false, false).map(|v| parse_length(Some(v)));
    let height: Option<Dim> = svg_attr(root, "height", false, false).map(|v| parse_length(Some(v)));
    let viewbox = svg_attr(root, "viewBox", true, true).map(|v| {
        let bounds: Vec<&str> = v.split(' ').collect();
        let w = parse_length(bounds.get(2).copied());
        let h = parse_length(bounds.get(3).copied());
        (w, h)
    });
    if truthy_dim(width) && truthy_dim(height) {
        return Ok(Calc {
            width: width.flatten(),
            height: height.flatten(),
            images: None,
        });
    }
    let Some((vw, vh)) = viewbox else {
        return Err(Thrown);
    };
    let num = |d: Dim| d.unwrap_or(f64::NAN);
    let ratio = num(vw) / num(vh);
    if truthy_dim(width) {
        let w = num(width.flatten());
        return Calc::wh(w, (w / ratio).floor());
    }
    if truthy_dim(height) {
        let h = num(height.flatten());
        return Calc::wh((h * ratio).floor(), h);
    }
    Ok(Calc {
        width: vw,
        height: vh,
        images: None,
    })
}

fn tiff(input: &V) -> R<Calc> {
    let big_endian = input.is(0, 2, b"MM");
    let big_tiff = input.uint(16, 2, big_endian)? == 43.0;
    if big_tiff {
        let byte_size = input.uint(16, 4, big_endian)?;
        let reserved = input.uint(16, 6, big_endian)?;
        if byte_size != 8.0 || reserved != 0.0 {
            return Err(Thrown); // "Invalid BigTIFF header"
        }
    }
    let ifd_offset = if big_tiff {
        input.u64(8, big_endian)?
    } else {
        input.uint(32, 4, big_endian)?
    };
    let count_size = if big_tiff { 8.0 } else { 2.0 };
    let mut temp = Some(input.slice(ifd_offset + count_size, None));
    let entry_size = if big_tiff { 20 } else { 12 };
    let mut width: Dim = None;
    let mut height: Dim = None;
    while let Some(t) = temp.filter(|t| t.len > 0) {
        let code = t.uint(16, 0, big_endian)?;
        let kind = t.uint(16, 2, big_endian)?;
        let length = if big_tiff {
            t.u64(4, big_endian)?
        } else {
            t.uint(32, 4, big_endian)?
        };
        if code == 0.0 {
            break;
        }
        if length == 1.0 && (kind == 3.0 || kind == 4.0 || (big_tiff && kind == 16.0)) {
            let at = if big_tiff { 12 } else { 8 };
            let value = match kind as u32 {
                3 => t.uint(16, at, big_endian)?,
                4 => t.uint(32, at, big_endian)?,
                _ => {
                    let v = t.u64(at, big_endian)?;
                    if v > 9_007_199_254_740_991.0 {
                        return Err(Thrown); // "Value too large"
                    }
                    v
                }
            };
            match code as u32 {
                256 => width = Some(value),
                257 => height = Some(value),
                _ => {}
            }
        }
        temp = (t.len > entry_size).then(|| t.slice(entry_size as f64, None));
    }
    let truthy = |d: Dim| d.is_some_and(|x| x != 0.0 && !x.is_nan());
    if !truthy(width) || !truthy(height) {
        return Err(Thrown); // "Invalid Tiff. Missing tags"
    }
    Ok(Calc {
        width,
        height,
        images: None,
    })
}

fn webp(whole: &V) -> R<Calc> {
    let input = whole.slice(20.0, Some(30.0));
    if whole.is(12, 16, b"VP8X") {
        // `undefined & 192` is 0: a missing byte passes both checks.
        let ext = input.at0(0);
        if ext & 192 == 0 && ext & 1 == 0 {
            let height = 1.0 + input.u24le(7)?;
            return Calc::wh(1.0 + input.u24le(4)?, height);
        }
        return Err(Thrown); // "Invalid WebP"
    }
    if whole.is(12, 16, b"VP8 ") && input.at(0) != Some(47) {
        let height = f64::from(input.i16le(8)? & 16383);
        return Calc::wh(f64::from(input.i16le(6)? & 16383), height);
    }
    if whole.is(12, 16, b"VP8L") && !input.hex_is(3, 6, &[0x9d, 0x01, 0x2a]) {
        let height =
            1 + (((input.at0(4) & 15) << 10) | (input.at0(3) << 2) | ((input.at0(2) & 192) >> 6));
        let width = 1 + (((input.at0(2) & 63) << 8) | input.at0(1));
        return Calc::wh(f64::from(width), f64::from(height));
    }
    Err(Thrown) // "Invalid WebP"
}

/// `detector(input)`: the first byte's type if it validates, else the first
/// type in `types` order that does. A validator's throw ends the search.
fn detect(input: &V) -> R<Option<Type>> {
    if let Some(t) = first_byte_type(input.at(0))
        && validate(t, input)?
    {
        return Ok(Some(t));
    }
    for t in TYPES {
        if validate(t, input)? {
            return Ok(Some(t));
        }
    }
    Ok(None)
}

/// `imageSize(buffer)`'s width and height: for a file with several images,
/// those of the largest (the first of equal ones; a product that is `NaN`
/// never wins).
pub fn image_size(bytes: &[u8]) -> Result<Size, Thrown> {
    let input = V::new(bytes);
    let t = detect(&input)?.ok_or(Thrown)?; // "unsupported file type"
    let calc = calculate(t, &input)?;
    let (mut width, mut height) = (calc.width, calc.height);
    if let Some(images) = calc.images.filter(|i| i.len() > 1) {
        let area = |(w, h): (Dim, Dim)| w.unwrap_or(f64::NAN) * h.unwrap_or(f64::NAN);
        let mut largest = images[0];
        for &current in &images {
            if area(current) > area(largest) {
                largest = current;
            }
        }
        (width, height) = largest;
    }
    Ok(Size { width, height })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_gif_and_garbage() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&[0, 0, 1, 0, 0, 0, 0, 200, 8, 6, 0, 0, 0]);
        assert_eq!(
            image_size(&png),
            Ok(Size {
                width: Some(256.0),
                height: Some(200.0)
            })
        );
        assert_eq!(
            image_size(b"GIF89a\x02\x00\x03\x00"),
            Ok(Size {
                width: Some(2.0),
                height: Some(3.0)
            })
        );
        assert_eq!(image_size(b""), Err(Thrown));
        assert_eq!(image_size(b"hello world"), Err(Thrown));
    }

    #[test]
    fn round_is_math_round() {
        for (x, want) in [
            (0.5, 1.0),
            (1.5, 2.0),
            (2.5, 3.0),
            (0.499_999_999_999_999_94, 0.0),
            (4_503_599_627_370_497.0, 4_503_599_627_370_497.0),
        ] {
            assert_eq!(js_round(x), want, "{x}");
        }
        assert!(js_round(f64::NAN).is_nan());
    }
}
