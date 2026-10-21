"""Ready-made scenarios."""

import numpy as np

from .section import rectangular
from .solver import Solver


def dam_break(section=None, N=400, L=100.0, x0=50.0, h_up=1.0, h_down=0.0, slope=0.0,
              n=0.0, bc_up="wall", bc_down="open", **kw):
    """Dam at x0. The upstream pool has a flat water level h_up above the bed at the dam;
    downstream has uniform depth h_down. With slope = 0 this is the textbook problem."""
    section = section or rectangular(1.0)

    def z0(x):
        return -slope * x

    eta_up = -slope * x0 + h_up

    def h0(x):
        return np.where(x < x0, np.maximum(eta_up - z0(x), 0.0), h_down)

    return Solver(section, N, L, z0, h0, n=n, bc_up=bc_up, bc_down=bc_down, **kw)
