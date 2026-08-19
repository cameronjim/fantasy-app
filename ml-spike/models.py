"""
Phase 0 spike: the model ladder.

Deliberately a LADDER, not a leaderboard: every target starts with the dumbest
defensible baseline (a shifted historical mean), then a linear model, then
LightGBM. If the gradient booster cannot beat a shifted rolling mean, that is a
finding about the target, not a bug to tune away.

Nothing here does any splitting - run_eval.py owns the rolling-origin scheme.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import log_loss, mean_absolute_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

import lightgbm as lgb

RANDOM_STATE = 17
EPS = 1e-3


# --------------------------------------------------------------------------
# metrics
# --------------------------------------------------------------------------
def brier(y_true: np.ndarray, p: np.ndarray) -> float:
    return float(np.mean((np.asarray(p) - np.asarray(y_true)) ** 2))


def logloss(y_true: np.ndarray, p: np.ndarray) -> float:
    p = np.clip(np.asarray(p, dtype=float), EPS, 1 - EPS)
    return float(log_loss(np.asarray(y_true), p, labels=[0, 1]))


def mae(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(mean_absolute_error(np.asarray(y_true), np.asarray(y_pred)))


# --------------------------------------------------------------------------
# model constructors
# --------------------------------------------------------------------------
def make_logistic() -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("clf", LogisticRegression(max_iter=2000, C=1.0, random_state=RANDOM_STATE)),
    ])


def make_ridge() -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("reg", Ridge(alpha=1.0, random_state=RANDOM_STATE)),
    ])


def make_lgbm_classifier() -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        n_estimators=400,
        learning_rate=0.05,
        num_leaves=31,
        min_child_samples=50,
        subsample=0.8,
        subsample_freq=1,
        colsample_bytree=0.8,
        random_state=RANDOM_STATE,
        verbosity=-1,
        n_jobs=-1,
    )


def make_lgbm_regressor() -> lgb.LGBMRegressor:
    return lgb.LGBMRegressor(
        n_estimators=400,
        learning_rate=0.05,
        num_leaves=31,
        min_child_samples=50,
        subsample=0.8,
        subsample_freq=1,
        colsample_bytree=0.8,
        random_state=RANDOM_STATE,
        verbosity=-1,
        n_jobs=-1,
    )


# --------------------------------------------------------------------------
# fit / predict helpers
# --------------------------------------------------------------------------
def fit_predict_proba(model, train: pd.DataFrame, valid: pd.DataFrame,
                      feature_cols: list[str], target: str) -> np.ndarray:
    """Fit a classifier on train, return P(y=1) on valid."""
    X_tr, y_tr = train[feature_cols], train[target].astype(int)
    model.fit(X_tr, y_tr)
    return model.predict_proba(valid[feature_cols])[:, 1]


def fit_predict(model, train: pd.DataFrame, valid: pd.DataFrame,
                feature_cols: list[str], target: str,
                clip_min: float | None = 0.0) -> np.ndarray:
    """Fit a regressor on train, return predictions on valid."""
    X_tr, y_tr = train[feature_cols], train[target]
    model.fit(X_tr, y_tr)
    pred = model.predict(valid[feature_cols])
    if clip_min is not None:
        pred = np.clip(pred, clip_min, None)
    return pred


def baseline_column(valid: pd.DataFrame, col: str, fallback: float) -> np.ndarray:
    """A baseline that is simply a precomputed shifted-history column."""
    return valid[col].fillna(fallback).to_numpy(dtype=float)
