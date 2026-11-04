//! Node's `path.posix` (`lib/path.js`, node 22) on JS strings: `resolve`,
//! `normalize`, `join`, `relative`, `dirname`, `basename` and `isAbsolute`, step for
//! step, so the routes that build and compare paths with them (`fs/dirs`,
//! `fs-list.ts`) produce the same strings.
//!
//! These only ever look at `/` and `.`, which are single bytes in UTF-8 and
//! single units in UTF-16, so walking the UTF-8 bytes gives the same result
//! as Node walking UTF-16 units, and every cut lands on a char boundary.
//! Nothing touches the filesystem; `resolve` reads the process cwd only when
//! no argument is absolute, like `process.cwd()`.
//!
//! Windows (`path.win32`) isn't ported: Claudius serves from macOS and Linux.

/// `process.cwd()`.
fn process_cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".into())
}

/// `path.isAbsolute(p)`.
pub fn is_absolute(p: &str) -> bool {
    p.starts_with('/')
}

/// Node's `normalizeString(path, allowAboveRoot, '/', isPosixPathSeparator)`.
fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let b = path.as_bytes();
    let mut res = String::new();
    let mut last_segment_length = 0usize;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code = 0u8;
    let mut i = 0usize;
    while i <= b.len() {
        if i < b.len() {
            code = b[i];
        } else if code == b'/' {
            break;
        } else {
            code = b'/';
        }
        if code == b'/' {
            if last_slash == i as isize - 1 || dots == 1 {
                // A doubled separator or a `.` segment: nothing to add.
            } else if dots == 2 {
                let r = res.as_bytes();
                let last_is_dotdot = r.len() >= 2
                    && last_segment_length == 2
                    && r[r.len() - 1] == b'.'
                    && r[r.len() - 2] == b'.';
                if !last_is_dotdot {
                    if res.len() > 2 {
                        match res.rfind('/') {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(at) => {
                                res.truncate(at);
                                // `res.length - 1 - res.lastIndexOf("/")`.
                                last_segment_length = match res.rfind('/') {
                                    Some(s) => res.len() - 1 - s,
                                    None => res.len(),
                                };
                            }
                        }
                        last_slash = i as isize;
                        dots = 0;
                        i += 1;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i as isize;
                        dots = 0;
                        i += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    res.push_str(if res.is_empty() { ".." } else { "/.." });
                    last_segment_length = 2;
                }
            } else {
                let start = (last_slash + 1) as usize;
                if !res.is_empty() {
                    res.push('/');
                }
                res.push_str(&path[start..i]);
                last_segment_length = i - start;
            }
            last_slash = i as isize;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        i += 1;
    }
    res
}

/// `path.resolve(...args)`: right to left until a segment is absolute,
/// then the process cwd; empty segments are skipped.
pub fn resolve(args: &[&str]) -> String {
    let mut resolved = String::new();
    let mut absolute = false;
    for path in args.iter().rev() {
        if path.is_empty() {
            continue;
        }
        resolved = format!("{path}/{resolved}");
        absolute = path.starts_with('/');
        if absolute {
            break;
        }
    }
    if !absolute {
        let cwd = process_cwd();
        if !cwd.is_empty() {
            resolved = format!("{cwd}/{resolved}");
            absolute = cwd.starts_with('/');
        }
    }
    let normalized = normalize_string(&resolved, !absolute);
    if absolute {
        format!("/{normalized}")
    } else if normalized.is_empty() {
        ".".into()
    } else {
        normalized
    }
}

/// `path.normalize(p)`.
pub fn normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let absolute = p.starts_with('/');
    let trailing = p.ends_with('/');
    let mut out = normalize_string(p, !absolute);
    if out.is_empty() {
        if absolute {
            return "/".into();
        }
        return if trailing { "./".into() } else { ".".into() };
    }
    if trailing {
        out.push('/');
    }
    if absolute { format!("/{out}") } else { out }
}

/// `path.join(...args)`: the non-empty segments joined with `/`, then
/// [`normalize`]d.
pub fn join(args: &[&str]) -> String {
    let parts: Vec<&str> = args.iter().copied().filter(|a| !a.is_empty()).collect();
    if parts.is_empty() {
        return ".".into();
    }
    normalize(&parts.join("/"))
}

/// `path.relative(from, to)`: both [`resolve`]d, then `..` for each segment
/// of `from` past the longest common directory, then the rest of `to`.
pub fn relative(from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from = resolve(&[from]);
    let to = resolve(&[to]);
    if from == to {
        return String::new();
    }
    let (f, t) = (from.as_bytes(), to.as_bytes());
    let (from_start, from_end) = (1usize, f.len());
    let from_len = from_end - from_start;
    let to_start = 1usize;
    let to_len = t.len() - to_start;
    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0usize;
    while i < length {
        let fc = f[from_start + i];
        if fc != t[to_start + i] {
            break;
        } else if fc == b'/' {
            last_common_sep = i as isize;
        }
        i += 1;
    }
    if i == length {
        if to_len > length {
            if t[to_start + i] == b'/' {
                // `from` is the exact base path for `to`.
                return to[to_start + i + 1..].to_owned();
            }
            if i == 0 {
                // `from` is the root.
                return to[to_start + i..].to_owned();
            }
        } else if from_len > length {
            if f[from_start + i] == b'/' {
                // `to` is the exact base path for `from`.
                last_common_sep = i as isize;
            } else if i == 0 {
                // `to` is the root.
                last_common_sep = 0;
            }
        }
    }
    let mut out = String::new();
    let mut j = (from_start as isize + last_common_sep + 1) as usize;
    while j <= from_end {
        if j == from_end || f[j] == b'/' {
            out.push_str(if out.is_empty() { ".." } else { "/.." });
        }
        j += 1;
    }
    out + &to[(to_start as isize + last_common_sep) as usize..]
}

/// `path.dirname(p)`.
pub fn dirname(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let b = p.as_bytes();
    let has_root = b[0] == b'/';
    let mut end: Option<usize> = None;
    let mut matched_slash = true;
    for i in (1..b.len()).rev() {
        if b[i] == b'/' {
            if !matched_slash {
                end = Some(i);
                break;
            }
        } else {
            matched_slash = false;
        }
    }
    match end {
        None => if has_root { "/" } else { "." }.into(),
        Some(1) if has_root => "//".into(),
        Some(e) => p[..e].to_owned(),
    }
}

/// `path.basename(p)` (no suffix): the last component, trailing slashes
/// ignored; `""` for `""` or only slashes.
pub fn basename(p: &str) -> String {
    let b = p.as_bytes();
    let (mut start, mut end) = (0, None);
    for i in (0..b.len()).rev() {
        if b[i] == b'/' {
            if end.is_some() {
                start = i + 1;
                break;
            }
        } else if end.is_none() {
            end = Some(i + 1);
        }
    }
    end.map_or_else(String::new, |e| p[start..e].to_owned())
}

#[cfg(test)]
mod basename_tests {
    use super::basename;

    #[test]
    fn basename_matches_node() {
        // node 22 `path.posix.basename`.
        for (p, want) in [
            ("", ""),
            ("/", ""),
            ("//", ""),
            ("a", "a"),
            ("/a", "a"),
            ("/a/b", "b"),
            ("/a/b/", "b"),
            ("/a/b//", "b"),
            ("a//b", "b"),
            ("/a/.", "."),
            ("/a/..", ".."),
            ("/a/.claudius", ".claudius"),
            (" /x y ", "x y "),
            ("/caf\u{e9}/\u{1f600}", "\u{1f600}"),
        ] {
            assert_eq!(basename(p), want, "{p:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_node_on_hand_picked_paths() {
        // From node's own test/parallel/test-path-*.js.
        assert_eq!(resolve(&["/var/lib", "../", "file/"]), "/var/file");
        assert_eq!(resolve(&["/var/lib", "/../", "file/"]), "/file");
        assert_eq!(resolve(&["/some/dir", ".", "/absolute/"]), "/absolute");
        assert_eq!(
            resolve(&["/foo/tmp.3/", "../tmp.3/cycles/root.js"]),
            "/foo/tmp.3/cycles/root.js"
        );
        assert_eq!(normalize("./fixtures///b/../b/c.js"), "fixtures/b/c.js");
        assert_eq!(normalize("/foo/../../../bar"), "/bar");
        assert_eq!(normalize("a//b//../b"), "a/b");
        assert_eq!(normalize("../../../foo/../../../bar"), "../../../../../bar");
        assert_eq!(normalize("bar/foo../.."), "bar");
        assert_eq!(normalize("bar/foo.././/../.."), ".");
        assert_eq!(normalize("../.../.././.../../../bar"), "../../bar");
        assert_eq!(normalize("./"), "./");
        assert_eq!(join(&[".", "x/b", "..", "/b/c.js"]), "x/b/c.js");
        assert_eq!(join(&["", ""]), ".");
        assert_eq!(join(&["/", "//foo"]), "/foo");
        assert_eq!(relative("/var/lib", "/var"), "..");
        assert_eq!(relative("/var/lib", "/bin"), "../../bin");
        assert_eq!(relative("/var/lib", "/var/apache"), "../apache");
        assert_eq!(relative("/", "/var/lib"), "var/lib");
        assert_eq!(
            relative("/foo/test", "/foo/test/bar/package.json"),
            "bar/package.json"
        );
        assert_eq!(relative("/foo/bar/baz-quux", "/foo/bar/baz"), "../baz");
        assert_eq!(relative("/baz-quux", "/baz"), "../baz");
        assert_eq!(relative("/page1/page2/foo", "/"), "../../..");
        assert_eq!(dirname("/a/b/"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("/"), "/");
        assert_eq!(dirname("//a"), "//");
        assert_eq!(dirname("a"), ".");
        assert_eq!(dirname("////"), "/");
    }
}
