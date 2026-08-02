"""the enforcement mechanism for MODEL.md section 13, `prospective_2026_27_v1`.

WHY THIS FILE EXISTS, and why it is a test file rather than a document.

Every number this package has published is retrospective. The out-of-fold discipline
is real, but the questions were chosen after the era was visible, and no amount of
forward-chaining fixes that. The 2026-27 season is the first genuinely prospective
test this system will ever get - and it is a prospective test only if the protocol
was fixed BEFORE opening night and never edited afterwards.

A document alone cannot hold that line. Someone re-tunes a halflife in November,
`config.py` and MODEL.md section 13 quietly disagree, and by April the "frozen"
protocol describes a configuration that never served a single slate. So the freeze is
asserted here instead: every value section 13 pins is compared against the live
module, and every checksum is recomputed from the bytes on disk.

**A FAILURE IN THIS FILE IS NOT A BUG IN THIS FILE.** It means the served
configuration moved after the freeze. The correct response is exactly one of:

  1. before opening night - bump `PROSPECTIVE_PROTOCOL_VERSION` to
     `prospective_2026_27_v2`, re-freeze section 13 against the new configuration,
     and update the literals here; or
  2. after opening night - revert the change. The 2026-27 artifact does not move
     mid-season, and a challenger gets its own feature_version and its own single
     look (section 13.6).

Editing a literal here to match a drifted constant, with no version bump, is the one
response that defeats the entire purpose and it should be treated as such in review.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from fnba_ml import config, overrides

ML_ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_DIR = ML_ROOT / "models" / "20260818"
REGISTRY = ML_ROOT / "models" / "registry.json"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --------------------------------------------------------------------------
# 1. the pinned artifact
# --------------------------------------------------------------------------


def test_frozen_artifact_directory_exists() -> None:
    assert ARTIFACT_DIR.is_dir(), (
        f"the frozen 2026-27 serving artifact {ARTIFACT_DIR} is missing. the "
        "protocol pins a specific set of bytes; without them there is nothing to "
        "run the prospective test with"
    )


@pytest.mark.parametrize(
    "filename", sorted(config.PROSPECTIVE_ARTIFACT_CHECKSUMS)
)
def test_pinned_checksum_matches_disk(filename: str) -> None:
    """the load-bearing assertion of the whole freeze.

    parametrised per file so a failure names WHICH artifact moved rather than
    reporting "a checksum changed". a retrained availability model and a rewritten
    metadata.json are very different events.
    """
    path = ARTIFACT_DIR / filename
    assert path.is_file(), f"{filename} is pinned by the protocol and is not on disk"
    assert _sha256(path) == config.PROSPECTIVE_ARTIFACT_CHECKSUMS[filename], (
        f"{filename} does not match the checksum frozen in "
        "config.PROSPECTIVE_ARTIFACT_CHECKSUMS. the serving artifact changed after "
        "the freeze - bump to prospective_2026_27_v2 and re-freeze MODEL.md "
        "section 13, or revert"
    )


def test_checksum_set_covers_the_whole_artifact_directory() -> None:
    """no file may be added to the artifact without being pinned.

    without this, a new file could appear in the served directory - a second model,
    a replacement quantile table - and every per-file checksum above would still
    pass, because none of them would be looking at it.
    """
    on_disk = {p.name for p in ARTIFACT_DIR.iterdir() if p.is_file()}
    assert on_disk == set(config.PROSPECTIVE_ARTIFACT_CHECKSUMS)


def test_pinned_checksums_agree_with_the_registry() -> None:
    """the registry is the independent record; the protocol must not contradict it."""
    entries = json.loads(REGISTRY.read_text())["entries"]
    entry = next(
        e for e in entries if e["model_version"] == config.PROSPECTIVE_MODEL_VERSION
    )
    recorded = {a["path"]: a["sha256"] for a in entry["artifacts"]}
    assert recorded == config.PROSPECTIVE_ARTIFACT_CHECKSUMS


def test_frozen_metadata_matches_the_protocol() -> None:
    """the artifact's own decision record, not just its bytes.

    the checksum proves metadata.json has not changed; this proves the thing it
    says is the thing section 13 froze. A run that loads this artifact reads its
    halflives and estimators out of THIS file (section 12.6), so if the artifact's
    record and the protocol ever disagreed, the served numbers would follow the
    artifact and the document would be describing a different model.
    """
    meta = json.loads((ARTIFACT_DIR / "metadata.json").read_text())
    assert meta["model_version"] == config.PROSPECTIVE_MODEL_VERSION
    assert meta["feature_version"] == config.PROSPECTIVE_FEATURE_VERSION
    assert meta["champions"] == config.PROSPECTIVE_CHAMPIONS
    assert meta["production"]["rate_halflives"] == config.PROSPECTIVE_RATE_HALFLIVES
    assert meta["production"]["rate_estimators"] == config.PROSPECTIVE_RATE_ESTIMATORS
    assert tuple(meta["production"]["rate_targets"]) == config.PROSPECTIVE_RATE_TARGETS
    assert tuple(meta["feature_cols"]) == tuple(config.FEATURE_COLS)


# --------------------------------------------------------------------------
# 2. the frozen serving configuration vs the live module
# --------------------------------------------------------------------------


def test_champions_have_not_drifted() -> None:
    assert config.CHAMPIONS == config.PROSPECTIVE_CHAMPIONS, (
        "a CHAMPIONS entry changed after the 2026-27 freeze. this is one of the "
        "named re-freeze triggers in MODEL.md 13.2"
    )


def test_rate_targets_have_not_drifted() -> None:
    assert config.RATE_TARGETS == config.PROSPECTIVE_RATE_TARGETS
    # the served vocabulary is RATE_TARGETS by construction, not by coincidence
    assert config.PRODUCTION_TARGETS == config.PROSPECTIVE_RATE_TARGETS


@pytest.mark.parametrize("stat", sorted(config.PROSPECTIVE_RATE_HALFLIVES))
def test_rate_halflife_has_not_drifted(stat: str) -> None:
    """per stat, so a failure names the stat whose memory was re-tuned."""
    assert config.rate_halflife(stat) == config.PROSPECTIVE_RATE_HALFLIVES[stat]
    assert config.RATE_HALFLIVES[stat] == config.PROSPECTIVE_RATE_HALFLIVES[stat]


@pytest.mark.parametrize("stat", sorted(config.PROSPECTIVE_RATE_ESTIMATORS))
def test_rate_estimator_has_not_drifted(stat: str) -> None:
    assert config.rate_estimator(stat) == config.PROSPECTIVE_RATE_ESTIMATORS[stat]


def test_steals_still_ships_the_expanding_baseline() -> None:
    """the one stat in the vocabulary that does not ship an EWMA.

    stated as its own assertion rather than left inside the parametrised sweep
    because it is the single most surprising entry in the frozen configuration, and
    a reader scanning failures should see it named.
    """
    assert config.rate_estimator("STL") == "expanding"
    assert all(
        config.rate_estimator(s) == "ewma"
        for s in config.PROSPECTIVE_RATE_TARGETS
        if s != "STL"
    )


def test_feature_contract_has_not_drifted() -> None:
    digest = hashlib.sha256("\n".join(config.FEATURE_COLS).encode()).hexdigest()
    assert len(config.FEATURE_COLS) == config.PROSPECTIVE_N_FEATURES
    assert digest == config.PROSPECTIVE_FEATURE_COLS_SHA256, (
        "FEATURE_COLS changed after the freeze. any change to the feature list - "
        "an addition, a removal, a reordering - invalidates the pinned artifact, "
        "which was fitted against this exact contract"
    )
    assert config.FEATURE_VERSION == config.PROSPECTIVE_FEATURE_VERSION
    assert config.SERVED_FEATURE_SET == "v3-honest"


def test_shadow_comparator_feature_sets_exist() -> None:
    """the ladder's shadow runs must name feature sets the package can actually build."""
    for name in config.PROSPECTIVE_SHADOW_FEATURE_SETS:
        assert name in config.FEATURE_SETS
    assert config.FEATURE_SETS["v1"] == config.BASE_FEATURE_COLS
    # the v1 comparator must remain free of teammate context, or the ladder's
    # bottom rung stops being a no-teammate-context floor
    assert not set(config.TEAMMATE_FEATURE_COLS) & set(config.FEATURE_SETS["v1"])
    assert not set(config.TEAMMATE_ORACLE_COLS) & set(config.FEATURE_SETS["v1"])


def test_override_constants_have_not_drifted() -> None:
    assert overrides.DEFAULT_POLICY.as_dict() == config.PROSPECTIVE_OVERRIDE_CONSTANTS


def test_probable_rule_is_still_a_floor_at_the_frozen_constants() -> None:
    """`w*p + s` is a floor on [0, 1] iff `s >= 1 - w`, with equality at the defaults.

    section 7.1 states that any change to either constant has to re-check this
    inequality rather than assume it. the freeze is the moment to encode the check.
    """
    w = config.PROSPECTIVE_OVERRIDE_CONSTANTS["probable_model_weight"]
    s = config.PROSPECTIVE_OVERRIDE_CONSTANTS["probable_shift"]
    # the tolerance is not laziness, it is the tight case: the defaults satisfy the
    # inequality with EQUALITY, and `1.0 - 0.85` is 0.15000000000000002 in binary
    # floating point, so a bare `>=` fails on the one configuration section 7.1 says
    # is correct. A future change that genuinely violates the condition misses by
    # orders of magnitude more than 1e-12.
    assert s - (1.0 - w) >= -1e-12

    # and the property itself, checked rather than only its algebraic condition: a
    # PROBABLE tag must never lower the model's own probability, anywhere on [0, 1]
    for p in (0.0, 0.01, 0.4, 0.85, 0.95, 0.999, 1.0):
        assert overrides.DEFAULT_POLICY.probability("probable", p) >= p - 1e-12


def test_horizon_definitions_have_not_drifted() -> None:
    assert config.HORIZON_WINDOWS == config.PROSPECTIVE_HORIZON_WINDOWS
    assert config.PROSPECTIVE_SERVING_HORIZON in config.HORIZON_WINDOWS
    assert config.DEFAULT_HORIZON == config.PROSPECTIVE_SERVING_HORIZON
    # the ops commitment is a gameday-horizon run before every slate; the frozen
    # horizon must be the one a measured offset in that window would be assigned
    lo, hi = config.HORIZON_WINDOWS[config.PROSPECTIVE_SERVING_HORIZON]
    assert config.horizon_for_offset((lo + hi) / 2) == config.PROSPECTIVE_SERVING_HORIZON


def test_coherence_constraints_have_not_drifted() -> None:
    assert config.COHERENCE_CONSTRAINTS == config.PROSPECTIVE_COHERENCE_CONSTRAINTS


def test_cohort_definitions_have_not_drifted() -> None:
    """the cohorts are fixed in advance, exactly as section 11 defined them.

    a prospective endpoint reported on cohorts that were re-cut mid-season is a
    retrospective endpoint wearing a prospective label.
    """
    assert config.TIER_EDGES == (10.0, 20.0, 30.0)
    assert config.TIER_LABELS == (
        "fringe (<10)", "bench (10-20)", "starter (20-30)", "star (>=30)",
    )
    assert config.TIER_BASIS == "roll10_MIN"
    assert config.EVENT_COHORTS == (
        ("event: vacated_minutes >= 30", "vacated_minutes", ">=", 30.0),
        ("event: star_out = 1", "star_out", ">=", 1.0),
        ("control: vacated_minutes < 5", "vacated_minutes", "<", 5.0),
    )


# --------------------------------------------------------------------------
# 3. the protocol's own shape
# --------------------------------------------------------------------------


def test_protocol_version_string() -> None:
    assert config.PROSPECTIVE_PROTOCOL_VERSION == "prospective_2026_27_v1"
    assert config.PROSPECTIVE_RUN_NOTE_LABEL == "prospective_2026_27_v1"
    assert config.PROSPECTIVE_2026_27["protocol_version"] == (
        config.PROSPECTIVE_PROTOCOL_VERSION
    )


def test_look_dates_are_what_section_13_says() -> None:
    """exactly three looks, on exactly these dates. section 13.6.

    the dates are asserted literally rather than derived, because the whole point
    of a look schedule is that it cannot be adjusted once the season is running and
    a partial result is visible.
    """
    assert config.PROSPECTIVE_LOOKS == (
        ("dec1", "2026-12-01", 7_500),
        ("all_star", "2027-02-15", 20_000),
        ("season_end", "2027-04-20", 32_000),
    )
    assert config.PROSPECTIVE_LOOK_DATES == (
        "2026-12-01", "2027-02-15", "2027-04-20",
    )
    assert len(config.PROSPECTIVE_LOOKS) == 3, "three looks. not two, and not four"


def test_look_dates_are_ordered_and_inside_the_season() -> None:
    import pandas as pd

    dates = [pd.Timestamp(d) for d in config.PROSPECTIVE_LOOK_DATES]
    assert dates == sorted(dates)
    assert pd.Timestamp("2026-10-20") < dates[0]
    assert dates[-1] < pd.Timestamp("2027-07-01")


def test_look_row_minimums_increase() -> None:
    """a later look cannot require less evidence than an earlier one."""
    minimums = [n for _, _, n in config.PROSPECTIVE_LOOKS]
    assert minimums == sorted(minimums)
    assert all(n > 0 for n in minimums)


def test_cold_start_flag_and_window() -> None:
    assert config.PROSPECTIVE_COLD_START_FLAG == "cold_start"
    assert config.PROSPECTIVE_COLD_START_THROUGH == "2026-11-30"
    assert config.PROSPECTIVE_OCTOBER_REPLAY_WINDOW == ("2025-10-01", "2025-10-31")
    # the flag must not collide with a stat name P5 would write into the same
    # long-format store
    assert config.PROSPECTIVE_COLD_START_FLAG not in config.PRODUCTION_TARGETS


def test_october_gate_criteria_are_frozen_numbers() -> None:
    gate = config.PROSPECTIVE_OCTOBER_GATE
    assert gate == {
        "max_brier_ratio": 1.42,
        "max_minutes_mae_ratio": 1.15,
        "min_prediction_coverage": 0.99,
    }
    # a degradation allowance below 1.0 would demand October be BETTER than the
    # rest of the season, which is not a gate, it is a wish
    assert gate["max_brier_ratio"] > 1.0
    assert gate["max_minutes_mae_ratio"] > 1.0
    assert 0.0 < gate["min_prediction_coverage"] <= 1.0


# --------------------------------------------------------------------------
# 4. the falsification table
# --------------------------------------------------------------------------

LOOK_NAMES = ("dec1", "all_star", "season_end")


def test_every_falsification_endpoint_names_all_three_looks() -> None:
    """no endpoint may be silent about a look.

    a `None` threshold means "report-only, this look has no power" and is a
    decision. a MISSING key is an oversight, and the difference matters: the first
    is pre-registered, the second gets argued about in February.
    """
    for name, spec in config.PROSPECTIVE_FALSIFICATION.items():
        assert set(spec["thresholds"]) == set(LOOK_NAMES), name
        assert spec["direction"] in ("lower_is_better", "higher_is_better"), name


def test_no_falsification_threshold_is_left_unset() -> None:
    """`None` is allowed; a placeholder string is not.

    an unfrozen number is the precise thing this document exists to prevent, so a
    "TBD" of any kind must fail loudly rather than read as a value.
    """
    for name, spec in config.PROSPECTIVE_FALSIFICATION.items():
        for look, value in spec["thresholds"].items():
            assert value is None or isinstance(value, (int, float)), (
                f"{name}/{look} is neither a number nor an explicit report-only None"
            )


def test_at_least_one_binding_threshold_per_endpoint() -> None:
    for name, spec in config.PROSPECTIVE_FALSIFICATION.items():
        assert any(v is not None for v in spec["thresholds"].values()), (
            f"{name} is report-only at every look, so it is not a falsification "
            "criterion at all"
        )


def test_thresholds_are_monotonically_stricter_across_looks() -> None:
    """a later look may not be EASIER to pass than an earlier one.

    this is what stops the protocol from being weakened by the calendar: with more
    data the bar tightens toward the retrospective effect size, it does not relax
    toward zero.
    """
    for name, spec in config.PROSPECTIVE_FALSIFICATION.items():
        seq = [spec["thresholds"][k] for k in LOOK_NAMES]
        seq = [v for v in seq if v is not None]
        if spec["direction"] == "lower_is_better":
            assert seq == sorted(seq, reverse=True), name
        else:
            assert seq == sorted(seq), name


def test_binding_thresholds_are_no_stronger_than_the_retrospective_effect() -> None:
    """the bar may never demand MORE than the retrospective claim itself.

    a protocol that requires the prospective season to beat the number it is
    testing has pre-registered its own failure. Two exemptions, both deliberate:
    endpoints with no retrospective measurement (`retrospective = None`, marked
    [JUDGMENT] in MODEL.md 13.9), and endpoints whose retrospective value is
    already on the FAILING side of its own bar - there the retrospective evidence
    contradicts the claim, and the bar has to sit where the claim would be true
    rather than where the evidence is (see the dedicated test below).
    """
    for name, spec in config.PROSPECTIVE_FALSIFICATION.items():
        retro = spec["retrospective"]
        if retro is None:
            continue
        supports_claim = (
            retro < 0 if spec["direction"] == "lower_is_better" else retro > 0
        )
        if not supports_claim:
            continue
        for look, value in spec["thresholds"].items():
            if value is None:
                continue
            if spec["direction"] == "lower_is_better":
                assert value >= retro, f"{name}/{look}"
            else:
                assert value <= retro, f"{name}/{look}"


def test_the_already_doubted_row_is_recorded_as_doubted() -> None:
    """REB/TOV/FG3M at halflife 20: the retrospective validation rows already
    disagree with the selection (section 12.4's "honest disagreement"), so the
    frozen retrospective value is NEGATIVE while the season-end bar is 0.

    pinned because it is the one row of the table we expect to fail, and an
    expectation recorded in advance is the only kind worth anything.
    """
    spec = config.PROSPECTIVE_FALSIFICATION["rare_event_h20_vs_expanding"]
    assert spec["retrospective"] < 0
    assert spec["thresholds"]["season_end"] == 0.00
    assert spec["thresholds"]["dec1"] is None
    assert spec["thresholds"]["all_star"] is None


def test_underpowered_looks_are_not_binding_downward() -> None:
    """at Dec 1 the teammate-context endpoints are wrong-sign tripwires only.

    the Dec 1 thresholds for the three v3-vs-v1 endpoints must sit on the WORSE
    side of zero: at ~1.5 month-blocks the minimum detectable effect is larger than
    the retrospective effect, so a bar that demanded improvement would be a coin
    flip dressed as a test.
    """
    for name in (
        "availability_brier_v3_vs_v1",
        "minutes_mae_v3_vs_v1",
        "pts_uncond_mae_v3_vs_v1",
    ):
        spec = config.PROSPECTIVE_FALSIFICATION[name]
        assert spec["direction"] == "lower_is_better"
        assert spec["thresholds"]["dec1"] > 0.0, name


def test_block_standard_deviations_are_present_where_a_threshold_was_derived() -> None:
    """every derived threshold must carry the variance estimate it was derived from.

    without it the numbers in the table are assertions; with it a reader can
    recompute the minimum detectable effect at any checkpoint and check our
    arithmetic.
    """
    for name, spec in config.PROSPECTIVE_FALSIFICATION.items():
        if spec["retrospective"] is None:
            assert spec["block_sd"] is None, name
        else:
            assert isinstance(spec["block_sd"], float) and spec["block_sd"] > 0, name


# --------------------------------------------------------------------------
# 5. the bundled dict a consumer serialises
# --------------------------------------------------------------------------


def test_bundle_is_json_serialisable() -> None:
    """a look script writes the pre-registration into its own report header.

    if the bundle cannot round-trip through json, that provenance silently becomes
    a `str(dict)` blob nobody can diff.
    """
    text = json.dumps(config.PROSPECTIVE_2026_27, sort_keys=True, default=list)
    assert json.loads(text)["protocol_version"] == "prospective_2026_27_v1"


def test_bundle_agrees_with_its_components() -> None:
    bundle = config.PROSPECTIVE_2026_27
    assert bundle["model_version"] == config.PROSPECTIVE_MODEL_VERSION
    assert bundle["feature_version"] == config.PROSPECTIVE_FEATURE_VERSION
    assert bundle["artifact_checksums"] == config.PROSPECTIVE_ARTIFACT_CHECKSUMS
    assert bundle["looks"] == config.PROSPECTIVE_LOOKS
    assert bundle["run_note_label"] == config.PROSPECTIVE_RUN_NOTE_LABEL
    assert bundle["cold_start_flag"] == config.PROSPECTIVE_COLD_START_FLAG
    assert bundle["champions"] == config.PROSPECTIVE_CHAMPIONS
    assert bundle["rate_halflives"] == config.PROSPECTIVE_RATE_HALFLIVES
    assert bundle["rate_estimators"] == config.PROSPECTIVE_RATE_ESTIMATORS
    assert bundle["falsification"] == config.PROSPECTIVE_FALSIFICATION
    assert bundle["artifact_dir"] == "models/20260818"


def test_model_md_section_13_exists_and_declares_the_same_protocol() -> None:
    """the document and the constants are two halves of one freeze.

    a light check on purpose - this asserts the section is present and names the
    protocol version, the artifact, the look dates and the run label. It is not a
    parser for the prose, because a test that tried to validate the falsification
    table out of markdown would break on a reworded caption and teach everyone to
    ignore it.
    """
    text = (ML_ROOT / "MODEL.md").read_text(encoding="utf-8")
    assert "## 13. `prospective_2026_27_v1` (FROZEN)" in text
    assert config.PROSPECTIVE_PROTOCOL_VERSION in text
    assert config.PROSPECTIVE_MODEL_VERSION in text
    assert config.PROSPECTIVE_COLD_START_FLAG in text
    for date in config.PROSPECTIVE_LOOK_DATES:
        assert date in text, f"look date {date} is in config and not in MODEL.md 13"
    for checksum in config.PROSPECTIVE_ARTIFACT_CHECKSUMS.values():
        assert checksum[:16] in text, "section 13.1 must show each pinned checksum"
