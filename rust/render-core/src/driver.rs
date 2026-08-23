//! Host-driver refusal: the one predicate that decides whether this host's
//! Vulkan driver is known to take the process down mid-render.
//!
//! Only `render.rs` calls it, and only on 32-bit ARM Linux, so on every other
//! target the module is compiled and unit-tested but never reached.
#![cfg_attr(
    not(all(target_arch = "arm", target_os = "linux")),
    allow(
        dead_code,
        reason = "the only call site is compiled on 32-bit ARM Linux alone"
    )
)]

use std::ffi::OsStr;

/// The lowest mesa major version observed to fault. Mesa 22.3.6 renders the
/// same scene on the same host, and 23.0.4 is the earliest release that dies.
const FIRST_FAULTING_MESA_MAJOR: u32 = 23;

/// Environment variable a consumer sets to render on a driver this module
/// refuses.
pub(crate) const OPT_OUT_VARIABLE: &str = "NANORASTER_ALLOW_UNSUPPORTED_DRIVER";

/// Read the mesa release out of a Vulkan `driverInfo` string.
///
/// Distributions append their own revision (`-2+deb13u1` on Debian, `-r0` on
/// Alpine) and most builds append the LLVM version in parentheses, so only the
/// dotted numbers up to the first separator are read. Anything that is not
/// `Mesa <major>.<minor>[.<patch>]` yields `None`, which makes the caller fail
/// open: refusing a driver whose version cannot be read would lock out
/// hardware drivers with unusual strings.
pub(crate) fn parse_mesa_version(driver_info: &str) -> Option<(u32, u32, u32)> {
    let release = driver_info.strip_prefix("Mesa ")?;
    let mut numbers = release.split([' ', '-', '+', '~']).next()?.split('.');
    let major = numbers.next()?.parse().ok()?;
    let minor = numbers.next()?.parse().ok()?;
    let patch = numbers.next().map_or(Ok(0), str::parse).ok()?;
    Some((major, minor, patch))
}

/// Decide whether this adapter is mesa's software rasteriser on a release that
/// takes the process down mid-render on 32-bit ARM.
///
/// Fires only for lavapipe on a readable mesa version at or past
/// [`FIRST_FAULTING_MESA_MAJOR`]. There is no upper bound: mesa carries no fix,
/// so every later release is refused until one names the fixed version, at
/// which point this gains a `< FIXED` bound and `compatibility.md` changes with
/// it.
pub(crate) fn unsupported_lavapipe(name: &str, driver: &str, driver_info: &str) -> Option<String> {
    if driver != "llvmpipe" && !name.starts_with("llvmpipe") {
        return None;
    }
    let (major, minor, patch) = parse_mesa_version(driver_info)?;
    if major < FIRST_FAULTING_MESA_MAJOR {
        return None;
    }
    Some(format!(
        "32-bit ARM with lavapipe from mesa {major}.{minor}.{patch}. \
         Mesa faults in lvp_execute.c handle_vertex_buffers2 on 32-bit ARM from mesa 23 onwards, \
         replaying a vertex-buffer bind through a stride pointer it never wrote, and the process \
         dies with it; mesa 22.3.6 renders. All of that evidence is emulated under qemu-user, so \
         real 32-bit ARM hardware may render. Set {OPT_OUT_VARIABLE}=1 to render anyway."
    ))
}

/// Whether the consumer asked to render on a refused driver.
///
/// Any non-empty value opts out, so `=0` bypasses the guard exactly as `=1`
/// does: this is a switch a consumer sets deliberately, not a tri-state.
pub(crate) fn opt_out_active(value: Option<&OsStr>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{opt_out_active, parse_mesa_version, unsupported_lavapipe};
    use std::ffi::OsStr;

    #[test]
    fn parses_every_driver_info_string_a_host_reports() {
        let cases = [
            ("Mesa 25.0.7-2+deb13u1 (LLVM 19.1.7)", (25, 0, 7)),
            ("Mesa 24.2.8 (LLVM 19.1.4)", (24, 2, 8)),
            ("Mesa 23.3.6 (LLVM 17.0.5)", (23, 3, 6)),
            ("Mesa 23.0.4 (LLVM 15.0.7)", (23, 0, 4)),
            ("Mesa 22.3.6 (LLVM 15.0.6)", (22, 3, 6)),
            ("Mesa 26.1.6 (LLVM 22.1.3)", (26, 1, 6)),
            ("Mesa 26.1.6-r0", (26, 1, 6)),
            ("Mesa 24.2.8", (24, 2, 8)),
            ("Mesa 23.0.4-r0 (LLVM 16.0.6)", (23, 0, 4)),
            ("Mesa 25.0.7~rc1", (25, 0, 7)),
            ("Mesa 22.3", (22, 3, 0)),
        ];
        // Whole-table comparison rather than a per-case message: a failure
        // then reports every row at once, and no assertion carries a format
        // argument that only a failing run would evaluate.
        let parsed: Vec<_> = cases
            .iter()
            .map(|(driver_info, _)| (*driver_info, parse_mesa_version(driver_info)))
            .collect();
        let expected: Vec<_> = cases
            .iter()
            .map(|(driver_info, version)| (*driver_info, Some(*version)))
            .collect();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn refuses_to_parse_anything_that_is_not_a_mesa_version() {
        let cases = [
            "",
            "llvmpipe",
            "Mesa",
            "Mesa ",
            "NVIDIA 550.x",
            "Mesa x.y",
            "Mesa 25",
            "Mesa 25.x.7",
            "Mesa 25.0.beta",
            "mesa 25.0.7",
        ];
        let parseable: Vec<_> = cases
            .into_iter()
            .filter(|driver_info| parse_mesa_version(driver_info).is_some())
            .collect();
        assert_eq!(parseable, Vec::<&str>::new());
    }

    #[test]
    fn fires_on_lavapipe_from_the_first_faulting_mesa_onwards() {
        let message = unsupported_lavapipe(
            "llvmpipe (LLVM 19.1.4, 128 bits)",
            "llvmpipe",
            "Mesa 24.2.8 (LLVM 19.1.4)",
        )
        .expect("mesa 24 lavapipe is refused");
        // Every claim the refusal has to carry: the host condition with the
        // parsed version, the upstream defect, the emulated evidence, and the
        // way out.
        let missing: Vec<_> = [
            "32-bit ARM",
            "lavapipe",
            "mesa 24.2.8",
            "lvp_execute.c",
            "handle_vertex_buffers2",
            "mesa 23",
            "qemu-user",
            "hardware",
            "NANORASTER_ALLOW_UNSUPPORTED_DRIVER=1",
        ]
        .into_iter()
        .filter(|claim| !message.contains(claim))
        .collect();
        assert_eq!(missing, Vec::<&str>::new());
        // The name alone identifies lavapipe when the driver field does not.
        assert!(
            unsupported_lavapipe(
                "llvmpipe (LLVM 15.0.7, 128 bits)",
                "",
                "Mesa 23.0.4 (LLVM 15.0.7)"
            )
            .is_some()
        );
        assert!(
            unsupported_lavapipe("", "llvmpipe", "Mesa 25.0.7-2+deb13u1 (LLVM 19.1.7)").is_some()
        );
    }

    #[test]
    fn fails_open_on_every_driver_it_cannot_convict() {
        // The version Debian bookworm ships renders; it is the boundary.
        assert_eq!(
            unsupported_lavapipe(
                "llvmpipe (LLVM 15.0.6, 128 bits)",
                "llvmpipe",
                "Mesa 22.3.6 (LLVM 15.0.6)"
            ),
            None
        );
        // An unparseable driver string is not evidence of anything.
        assert_eq!(
            unsupported_lavapipe("llvmpipe", "llvmpipe", "some vendor build"),
            None
        );
        // A hardware driver keeps rendering whatever its strings look like.
        assert_eq!(
            unsupported_lavapipe("Mali-G610", "panfrost", "Mesa 25.0.7 (LLVM 19.1.7)"),
            None
        );
    }

    #[test]
    fn any_non_empty_opt_out_value_bypasses_the_guard() {
        assert!(!opt_out_active(None));
        assert!(!opt_out_active(Some(OsStr::new(""))));
        assert!(opt_out_active(Some(OsStr::new("1"))));
        assert!(opt_out_active(Some(OsStr::new("0"))));
        assert!(opt_out_active(Some(OsStr::new("no"))));
    }
}
