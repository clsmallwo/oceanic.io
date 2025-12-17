import React, { useMemo, useState } from 'react';

function safePct(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function pctColor(pct) {
  if (pct === null) return '#aaa';
  if (pct >= 50) return '#4CAF50';
  if (pct >= 30) return '#FFC107';
  return '#F44336';
}

function getFactorInfoTooltip(factorName) {
  const n = String(factorName || '').toLowerCase();
  if (n.includes('breakthrough')) {
    return 'Breakthrough probability = chance that at least 2 offensive units in your current wave get through (X ~ Binomial(n, p)). Here p is computed from current game stats (HP/speed/distance/enemy DPS), not hard-coded.';
  }
  return null;
}

export default function ProbabilityTree({ gameState, myPlayerId, onClose }) {
  const [openMathKey, setOpenMathKey] = useState(null); // `${playerId}:${stepKey}`

  const model = useMemo(() => {
    if (!gameState?.players) return null;

    // Prefer AP-stats model if present; fall back to legacy aiWinProbabilities.
    const wpByPlayer =
      (gameState.aiWinProbabilitiesAP && Object.keys(gameState.aiWinProbabilitiesAP).length > 0)
        ? gameState.aiWinProbabilitiesAP
        : (gameState.aiWinProbabilities || {});

    const modelLabel =
      (wpByPlayer === gameState.aiWinProbabilitiesAP) ? 'AP Stats' : 'Legacy';

    const players = Object.values(gameState.players)
      .filter(p => p && !p.eliminated)
      .map(p => {
        const wp = wpByPlayer?.[p.id] || null;
        const pct = safePct(wp?.percentage);
        return {
          id: p.id,
          name: p.username || `Player ${String(p.id).substr(0, 4)}`,
          color: p.color || '#00bfff',
          isMe: !!(myPlayerId && p.id === myPlayerId),
          winProb: wp,
          pct
        };
      })
      .sort((a, b) => {
        if (a.pct === null && b.pct === null) return 0;
        if (a.pct === null) return 1;
        if (b.pct === null) return -1;
        return b.pct - a.pct;
      });

    return {
      turn: gameState.turnNumber || 1,
      phaseName: gameState.gamePhase?.name,
      modelLabel,
      players
    };
  }, [gameState, myPlayerId]);

  if (!model) return null;

  return (
    <div className="probability-tree-panel" role="dialog" aria-label="Probability Tree">
      <div className="probability-tree-header">
        <div>
          <div className="probability-tree-title">Probability Tree</div>
          <div className="probability-tree-subtitle">
            Turn #{model.turn}
            {model.phaseName ? ` · ${model.phaseName}` : ''}
            {model.modelLabel ? ` · Model: ${model.modelLabel}` : ''}
          </div>
        </div>
        <button className="probability-tree-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="probability-tree-root">
        {model.players.length === 0 ? (
          <div className="probability-tree-empty">No active players.</div>
        ) : (
          model.players.map(p => {
            const pct = p.pct;
            const color = pctColor(pct);
            const explainSteps = p.winProb?.explain?.steps || [];
            return (
              <details key={p.id} className={`probability-tree-player ${p.isMe ? 'me' : ''}`} open>
                <summary className="probability-tree-player-summary">
                  <span className="probability-tree-dot" style={{ background: p.color }} />
                  <span className="probability-tree-player-name">{p.name}{p.isMe ? ' (YOU)' : ''}</span>
                  <span className="probability-tree-player-prob" style={{ color }}>
                    {pct === null ? 'Win: —' : `Win: ${pct.toFixed(1)}%`}
                  </span>
                </summary>

                <div className="probability-tree-player-body">
                  <div className="probability-tree-bar">
                    <div className="probability-tree-bar-bg" />
                    <div
                      className="probability-tree-bar-fill"
                      style={{
                        width: pct === null ? '0%' : `${pct}%`,
                        background: color
                      }}
                    />
                  </div>

                  <div className="probability-tree-factors">
                    {(p.winProb?.factors || []).length === 0 ? (
                      <div className="probability-tree-factor muted">
                        Factors not available yet (the server only computes these while the game is playing).
                      </div>
                    ) : (
                      (p.winProb?.factors || []).map((f, idx) => {
                        // Match factor rows to an explain step (best-effort by name).
                        const stepKeyByName = (() => {
                          const n = String(f.name || '').toLowerCase();
                          if (n.includes('base hp')) return 'baseHpPct';
                          if (n.includes('offense dps')) return 'offenseDps';
                          if (n.includes('breakthrough')) return 'breakthrough';
                          if (n.includes('hand ev') || n.includes('damage/elixir')) return 'efficiency';
                          if (n.includes('primary target') || n.includes('target distance')) return 'matchups';
                          if (n.includes('game phase') || n.includes('model')) return 'final';
                          return null;
                        })();

                        const step = stepKeyByName ? explainSteps.find(s => s.key === stepKeyByName) : null;
                        const mathKey = step ? `${p.id}:${step.key}` : null;
                        const isOpen = mathKey && openMathKey === mathKey;
                        const infoTooltip = getFactorInfoTooltip(f.name);

                        return (
                          <div key={`${p.id}-f-${idx}`} className="probability-tree-factor">
                            <span className="probability-tree-branch">↳</span>
                            <span className="probability-tree-factor-name">{f.name}</span>
                            <span className="probability-tree-factor-value">
                              {f.value}
                              {infoTooltip && (
                                <span className="probability-tree-info" title={infoTooltip} aria-label={infoTooltip}>
                                  i
                                </span>
                              )}
                              {step && (
                                <button
                                  type="button"
                                  className="probability-tree-ellipsis"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setOpenMathKey(prev => (prev === mathKey ? null : mathKey));
                                  }}
                                  aria-label={`Show math for ${f.name}`}
                                  aria-expanded={!!isOpen}
                                >
                                  ...
                                </button>
                              )}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Math / steps panel (toggled by "..." next to a stat) */}
                  {(() => {
                    if (!openMathKey || !String(openMathKey).startsWith(`${p.id}:`)) return null;
                    const stepKey = openMathKey.split(':')[1];
                    const step = explainSteps.find(s => s.key === stepKey);
                    if (!step) return null;
                    return (
                      <div className="probability-tree-math">
                        <div className="probability-tree-math-title">{step.title}</div>
                        {step.meaning && (
                          <div className="probability-tree-math-row">
                            <span className="probability-tree-math-label">What this represents</span>
                            <div className="probability-tree-math-code">{step.meaning}</div>
                          </div>
                        )}
                        <div className="probability-tree-math-row">
                          <span className="probability-tree-math-label">Formula</span>
                          <div className="probability-tree-math-code">{step.formula}</div>
                        </div>
                        <div className="probability-tree-math-row">
                          <span className="probability-tree-math-label">Substitution</span>
                          <div className="probability-tree-math-code">{step.substitution}</div>
                        </div>
                        <div className="probability-tree-math-row">
                          <span className="probability-tree-math-label">Result</span>
                          <div className="probability-tree-math-code">
                            {typeof step.result === 'number' ? step.result.toFixed(6) : String(step.result)}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </details>
            );
          })
        )}
      </div>
    </div>
  );
}


