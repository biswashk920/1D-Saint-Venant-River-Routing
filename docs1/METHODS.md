# Methods

This document explains what the solver computes, how, and why each choice was made. Everything here is
implemented twice (Python reference in `src/svroute/`, JavaScript port in `web/`) and the two are checked
against each other.

## 1. Governing equations

Unsteady open-channel flow in a **prismatic channel** (the cross-section does not change along the reach) is
described by the 1D Saint-Venant equations, written in conservative form for flow area `A(x,t)` and discharge
`Q(x,t)`:

```
dA/dt + dQ/dx = 0
dQ/dt + d( Q^2/A + g I1(h) )/dx = - g Abar dz/dx - g n^2 |Q| Q P^(4/3) / A^(7/3)
```

* `h` is the depth, `z(x)` the bed elevation, `g = 9.81 m/s^2`.
* `I1(h) = integral from 0 to h of A(eta) d(eta)` is the hydrostatic pressure integral: the pressure force on
  a section is `g I1`. In a prismatic channel `dI1/dx = A dh/dx`, which is what makes the bed-slope source
  term balance the pressure gradient exactly (section 4).
* The last term is Manning friction with perimeter `P` and hydraulic radius `R = A/P`.

### Cross-sections

A section is symmetric and defined by its top width `B(h)`, piecewise linear in depth. From `B` every quantity
the solver needs is exact (no tables, no interpolation):

| Quantity | Definition | Closed form per linear segment |
|---|---|---|
| Area | `A(h) = int B dh` | quadratic in `h` |
| Pressure integral | `I1(h) = int A dh` | cubic in `h` |
| Perimeter | `P(h) = B(0) + int sqrt(4 + B'^2) dh` | linear in `h` |
| Inverse | `h(A)` | root of a quadratic (stable form `2 dA / (b + sqrt(b^2 + 2 s dA))`) |
| Celerity | `c = sqrt(g A / B)` | |

Rectangular, trapezoidal, V-shaped and compound (main channel plus floodplain) sections are built from this.
For a compound section the floodplain step is a steep but continuous segment; the perimeter formula then
counts the floodplain bed correctly.

The Riemann invariant integral `F(h) = int_0^h sqrt(g B/A) dh` (used for dry-front speeds and exact solutions)
is tabulated with a midpoint rule in `u = sqrt(h)`, where the integrand is smooth even at `h -> 0`. For a
rectangle `F = 2 sqrt(g h)`; for a V-valley `F = 2 sqrt(2 g h)`; both are checked in the tests.

## 2. Numerical scheme

Finite volumes on a uniform grid, cell averages of `A` and `Q`.

1. **Reconstruction.** MUSCL with a minmod limiter on the free-surface elevation `eta = h + z`, the velocity
   `u = Q/A`, and the bed `z`. Reconstructing `eta` (not `h`) is what lets a still lake stay still.
2. **Hydrostatic reconstruction** (Audusse et al., 2004). At each interface the two face depths are made
   consistent with a common bed `z* = max(zL, zR)`: `hL* = max(0, etaL - z*)`, `hR* = max(0, etaR - z*)`.
3. **Riemann solver.** HLL with Einfeldt wave-speed estimates (Roe-averaged velocity and celerity). Next to a
   dry cell the speed is taken from the exact dry-front solution, `u -/+ F(h)`, rather than an estimate, so the
   tip of a dam-break wave travels at the right speed in every cross-section.
4. **Well-balanced source.** The cell sees pressure corrections `g (I1(hface) - I1(h*))` at both faces and the
   bed source `-g Abar dz/dx`, with `Abar` the *mean of `A(h)` over the depth interval between the two face
   depths*, i.e. `Abar = (I1(hR) - I1(hL)) / (hR - hL)`. This choice makes the net force exactly zero for a
   lake at rest in **any** section, over any bed, to round-off (verified for four sections, residuals about
   1e-15 m).
5. **Positivity-preserving flux limiter.** A cell may not export more water in one step than it contains: the
   interface flux is scaled by `theta = min(1, A dx / (outflow dt))`. Without this the scheme occasionally
   produced slightly negative areas at a receding shoreline, and flooring them created mass (0.7% after two
   oscillation periods in the Thacker test). With it, mass is conserved to round-off while shorelines move.
6. **Time stepping.** SSP-RK2 (Heun). Each Euler substep is followed by the friction update and the dry-cell
   cleanup, so every intermediate state respects the boundary conditions. The time step is adaptive,
   `dt = CFL dx / max(|u| + c)` with CFL = 0.4.
7. **Friction.** Fully implicit Manning, solved exactly: `Q_new (1 + dt k |Q_new|) = Q_pre` with
   `k = g n^2 P^(4/3) / A^(7/3)`, a quadratic with closed-form root. Bed slope and friction then balance
   exactly at steady state, so uniform flow is reproduced to round-off (an earlier operator-split version drifted
   by 0.2%, which is how this choice was motivated).
8. **Dry cells.** A cell with `h <= 1e-4 m` is treated as dry (zero discharge) but **keeps** its sub-threshold
   film of water, so no mass is deleted.

### Boundary conditions

| Boundary | Options |
|---|---|
| Upstream | `wall`, `open` (zero gradient), `flow` (prescribed discharge `Q(t)`, e.g. a flood hydrograph) |
| Downstream | `wall`, `open` (zero gradient), `depth` (prescribed depth) |

## 3. Exact solutions used for validation

All of these are implemented independently of the solver (`src/svroute/analytical.py`) and generalised to any
prismatic section.

**Dam break onto a dry bed (generalised Ritter).** Behind the dam the fluid is at rest, so the Riemann invariant
`u + F(h) = F(h0)` holds throughout the fan, and fan characteristics satisfy `(x - x0)/t = u - c(h)`. Sweeping `h`
from `h0` to 0 gives the profile parametrically; the front moves at `F(h0)`. For a rectangle this is the classical
Ritter solution `h = (2 c0 - xi)^2 / (9 g)`.

**Dam break onto a wet bed (generalised Stoker).** A fan joins the pool to a constant middle state `(hm, um)`,
followed by a bore into the still tailwater `hd`. Mass and momentum across the bore give

```
um = sqrt( g (I1m - I1d)(Am - Ad) / (Am Ad) ),   S = um Am / (Am - Ad)
```

and the fan gives `um = F(h0) - F(hm)`. Solving these two for `hm` (bisection) closes the problem. For a
rectangle it reduces to Stoker's textbook formulas; this reduction is a unit test.

**Thacker oscillating lake.** In a parabolic bowl `z = kappa (x - L/2)^2` the free surface stays planar and the
velocity is uniform in space: `h = hmax - kappa (x - L/2 - X(t))^2` with `X(t) = X0 cos(omega t)` and
`omega = sqrt(2 g kappa)`. It exercises wet/dry fronts, a bed source term and mass conservation at once.

**Manufactured steady state.** Choose a smooth depth profile `h(x)` and discharge `Q`; the steady energy equation
gives the bed slope that makes it exact: `dz/dx = (Fr^2 - 1) dh/dx - Sf`. The solver, started from rest-like
conditions, must converge to `h(x)`. This tests bed slope, friction and boundary conditions together.

**Manning normal depth.** `Q = (1/n) A R^(2/3) sqrt(S0)` inverted by bisection for each section; uniform flow at
that depth must be a steady solution, and a perturbed state must relax to it.

## 4. Why the scheme is built this way

* A **Godunov-type finite-volume** scheme captures bores and shocks without the oscillations of classical
  implicit (Preissmann) river schemes.
* **Area-discharge unknowns with an exact `I1`** make non-rectangular sections a genuine part of the
  conservation law rather than a post-processing step: the pressure force of a trapezoid is not that of a
  rectangle.
* **Exact well-balancing** matters in practice: an unbalanced scheme invents flow in still water over a rough bed.
* **Positivity and exact mass conservation** matter for flood inundation, where water arrives at dry cells.

## 5. The 3D and space-time views

The 3D view is a **rendering of the 1D solution**, not a 2D simulation.

* The valley is built from the section outline `(B(h)/2, h)`: the terrain at lateral offset `y` has height
  `z(x) + d(y)` where `d` inverts the half-width function. Beyond the display bank height the terrain levels into
  a plain.
* At each station the water surface is flat across the channel at elevation `eta(x,t) = z + h` and spans
  `|y| <= B(h)/2`. The lateral spread of the flood is therefore the section width at the *computed* depth.
* **Exaggeration.** A reach tens of kilometres long with metres of water cannot be drawn to scale, so the vertical
  and lateral scales are exaggerated independently (sliders; the factors are printed on the view).
* **Layers.** Depth, velocity, Froude number, and `depth x velocity` hazard. The hazard bands are illustrative,
  not a regulatory standard; adapt them to your jurisdiction.
* **Gauges.** Posts that report, from the stored solution history, the arrival time of a threshold depth, the peak
  depth and the peak `depth x velocity`.
* **Flow streaks** are tracer particles advected with the computed cross-section-mean velocity, with streak length
  proportional to speed. **Foam** is a cosmetic highlight at steep, supercritical fronts.
* **Exact overlay.** For flat, frictionless dam breaks (any section) and the rectangular Thacker bowl, the exact
  surface is drawn over the numerical one, and its characteristic lines are drawn on the floor of the space-time
  plot.
* **Space-time surface.** `h(x,t)` assembled from the stored history, with the exact wave paths for dam breaks.

## 6. Verification process

1. Implement the sections and check each closed form (`A`, `I1`, `P`, `F`, the inverse).
2. Implement the solver and the independent exact solutions; compare.
3. When a test failed, find the cause before changing tolerances. Three findings shaped the final scheme:
   mass created by flooring negative areas (fixed by the flux limiter), a 0.2% uniform-flow drift (fixed by
   exact implicit friction applied per substep), and a boundary mismatch from applying friction only after the
   full step.
4. Port to JavaScript line for line; generate reference results in Python for 16 cases and require agreement.
5. Run the full application in headless Chromium: numerics, every scenario and cross-section in 2D, 3D and
   space-time, layers, cut-away, exaggeration, camera controls, gauge physics, share links and clip recording,
   with a clean console.

Results are in [VALIDATION.md](VALIDATION.md).

## 7. References

Listed for orientation; check bibliographic details before citing formally.

* Ritter, A. (1892). Die Fortpflanzung der Wasserwellen. *Z. Ver. Dt. Ing.* 36.
* Stoker, J. J. (1957). *Water Waves*. Interscience.
* Thacker, W. C. (1981). Some exact solutions to the nonlinear shallow-water wave equations. *J. Fluid Mech.* 107.
* Harten, A., Lax, P. D., van Leer, B. (1983). On upstream differencing and Godunov-type schemes for hyperbolic
  conservation laws. *SIAM Review* 25.
* Einfeldt, B. (1988). On Godunov-type methods for gas dynamics. *SIAM J. Numer. Anal.* 25.
* Audusse, E., Bouchut, F., Bristeau, M.-O., Klein, R., Perthame, B. (2004). A fast and stable well-balanced
  scheme with hydrostatic reconstruction for shallow water flows. *SIAM J. Sci. Comput.* 25.
* Gottlieb, S., Shu, C.-W., Tadmor, E. (2001). Strong stability-preserving high-order time discretization
  methods. *SIAM Review* 43.
* MacDonald, I., Baines, M. J., Nichols, N. K., Samuels, P. G. (1997). Analytic benchmark solutions for
  open-channel flows. *J. Hydraulic Eng.* 123.
* Chow, V. T. (1959). *Open-Channel Hydraulics*. McGraw-Hill.
