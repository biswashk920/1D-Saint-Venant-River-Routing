"""svroute: 1D Saint-Venant (shallow water) solver for dam-break and flood routing in prismatic channels."""

from .analytical import ritter, stoker, thacker
from .scenarios import dam_break
from .section import Section, compound, from_spec, rectangular, trapezoid, vee
from .solver import G, Solver

__all__ = ["Solver", "G", "Section", "rectangular", "trapezoid", "vee", "compound", "from_spec",
           "ritter", "stoker", "thacker", "dam_break"]
__version__ = "0.2.0"
