"""the production-rate tournament: a pre-registered bracket of rate estimators.

read ``TOURNAMENT.md`` section 0 before anything else - it is the pre-registration,
written and saved before a single result was computed, and it is what makes the
numbers in section 1 interpretable rather than merely reported.

nothing in this package imports from anything in ``ml/experiments`` outside it, and
nothing outside it imports from here. it reads ``fnba_ml`` (config, features, models)
and never writes to it.
"""
