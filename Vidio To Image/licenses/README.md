# Runtime notice fallback

The Windows CPython distribution installs Tk's `license.terms`, but omits Tcl's
upstream notice. The portable builder uses installed runtime notices first and
uses this checked-in Tcl notice only when the installed notice is absent and its
exact runtime version matches. Packaging does not download notices.

`tcl-8.6.15-license.terms` is preserved verbatim from the official
[Tcl 8.6.15 release](https://github.com/tcltk/tcl/blob/core-8-6-15/license.terms).
The builder fails if a required Python, Tcl or Tk notice cannot be found. Native
portable acceptance also verifies that the notices are present in the bundle.
