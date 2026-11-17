//! The "Auto-fix conflicts" prompt: the substitution of
//! `app/api/customizations/[id]/auto-fix/route.ts` (D14) over the template
//! `getSettings()` reads ([`crate::customize_settings`], D16).
//!
//! [`compose_prompt`] is the route's two `replaceAll`s: the conflict count,
//! then the `  - <path>` lines. Each is JS `String.prototype.replaceAll`
//! with a string pattern, so `$` patterns in the replacement text are
//! expanded (`GetSubstitution`), and what one replacement inserts is never
//! searched again.

/// The route's prompt: `template` with `{{conflict_count}}` and then
/// `{{conflict_paths}}` filled in for the conflicting `paths`.
pub fn compose_prompt(template: &str, paths: &[&str]) -> String {
    let count = paths.len().to_string();
    let listed = paths
        .iter()
        .map(|p| format!("  - {p}"))
        .collect::<Vec<_>>()
        .join("\n");
    let composed = replace_all(template, "{{conflict_count}}", &count);
    replace_all(&composed, "{{conflict_paths}}", &listed)
}

/// `template.replaceAll(from, to)` for a literal `from`, honouring
/// `GetSubstitution`: `$$` is a `$`, `$&` the match, ``$` `` and `$'` the
/// text before and after it, and any other `$x` stays as it is.
pub fn replace_all(template: &str, from: &str, to: &str) -> String {
    if from.is_empty() {
        return template.to_owned();
    }
    let mut out = String::with_capacity(template.len());
    let mut pos = 0;
    while let Some(at) = template[pos..].find(from) {
        let start = pos + at;
        out.push_str(&template[pos..start]);
        out.push_str(&substitute(
            to,
            from,
            &template[..start],
            &template[start + from.len()..],
        ));
        pos = start + from.len();
    }
    out.push_str(&template[pos..]);
    out
}

/// One replacement's `GetSubstitution`.
fn substitute(to: &str, matched: &str, before: &str, after: &str) -> String {
    let mut out = String::with_capacity(to.len());
    let mut chars = to.char_indices().peekable();
    while let Some((_, c)) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        match chars.peek().map(|(_, c)| *c) {
            Some('$') => {
                out.push('$');
                chars.next();
            }
            Some('&') => {
                out.push_str(matched);
                chars.next();
            }
            Some('`') => {
                out.push_str(before);
                chars.next();
            }
            Some('\'') => {
                out.push_str(after);
                chars.next();
            }
            _ => out.push('$'),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitution_patterns_match_js() {
        assert_eq!(replace_all("a{{x}}b", "{{x}}", "$&"), "a{{x}}b");
        assert_eq!(replace_all("a{{x}}b", "{{x}}", "$$"), "a$b");
        assert_eq!(replace_all("a{{x}}b", "{{x}}", "[$`|$']"), "a[a|b]b");
        assert_eq!(replace_all("a{{x}}b", "{{x}}", "$z"), "a$zb");
        assert_eq!(replace_all("xx", "x", "y$&"), "yxyx");
    }
}
