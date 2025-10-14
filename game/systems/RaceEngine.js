// 系統：賽跑邏輯引擎（抽離版）
// 變更摘要：
// - 移除目標時間收斂。保留 forcedTop5Rank。
// - 調整 LOCK.gain.pos 並限制 posFactor 最大值 (MAX_POS_FACTOR) 以抑制後期速度持續增長。
// - 【修正】補回遺失的 initWithHorses 函式定義。

import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';

export class RaceEngine {
  /**
   * @param {{ laneCount:number, startLineX:number, finishLineX:number, finishDetectX:number,
   * noise:(t:number,i:number)=>number, randFloat:(a:number,b:number)=>number, clamp:(v,a,b)=>number, lerp:(a,b,t)=>number,
   * log?:Function }} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.log = cfg.log || (() => { });

    // ===== 參數（已調整 pos 增益和 MAX_POS_FACTOR） =====
    this.SLOWMO = { enabled: true, triggerPct: 0.97, rate: 0.3, active: false, triggeredAt: null };
    this.LOCK_STAGE = { None: 'None', PreLock: 'PreLock', LockStrong: 'LockStrong', FinishGuard: 'FinishGuard' };
    this.LOCK = {
      preTriggerPct: 0.80, triggerPct: 0.85, releasePct: 0.72,
      minGapBase: 0.60, minGapMax: 1.20, gapWidenFrom: 0.90, gapWidenTo: 1.00,
      gain: {
        // 降低 pos 增益
        Pre: { boost: 0.20, brake: 0.15, pos: 0.005, forcedBoost: 0.60, forcedBrake: 0.80 },
        Strong: { boost: 0.10, brake: 0.70, pos: 0.010, forcedBoost: 1.20, forcedBrake: 1.20 },
        Guard: { boost: 0.30, brake: 0.25, pos: 0.008, forcedBoost: 0.80, forcedBrake: 0.90 },
      },
      noSpeedLimitInStrong: true,
      // 限制 posFactor 的最大倍率
      MAX_POS_FACTOR: 1, 
    };
    this.SPEED_CONF = { vMin: 100, vMax: 150, blend: 0.10, noiseScaleStart: 1.0, noiseScaleSetup: 0.4, noiseScaleLock: 0.2 };
    this.PHASE_SPLITS = { start: 0.60, setup: 0.85, lock: 0.97 };
    this.RHYTHM_CONF = {
      segment: { durMin: 0.9, durMax: 1.4, multMin: 0.70, multMax: 1.0, easeSec: 0.25 },
      burst: { probPerSec: 0.45, ampMin: 0.06, ampMax: 0.10, durSec: 0.8, cooldownSec: 0.6 },
      weightByPhase: { start: 1.00, mid: 1.00, setup: 0.30, lock: 0.12 },
      bounds: { min: 0.75, max: 1.35 },
    };
    this.SPRINT = {
      cooldownSec: 3.0, durMin: 0.8, durMax: 1.2, multMin: 1.15, multMax: 1.25,
      maxTimesPerHorse: 1, gapMin: 2.0, gapMax: 10.0,
    };

    // ===== 內部狀態（不變） =====
    this.horses = [];
    this.baseSpeeds = [];
    this.speedState = { v: [] };
    this.rhythmState = null;
    this.sprintState = null;
    this.RACE = { durationMinSec: 22, durationMaxSec: 28, durationSec: null, startTime: null, setupDone: false };
    this.finishedTimes = [];
    this.finalRank = [];
    this.lockStage = this.LOCK_STAGE.None;
    this.leader = null;
    this.forcedTop5Rank = null; 
    this._flags = { firstHorseFinished: false };
    this.slowmoSnapshotV = [];
    this.postFinishSpeedUp = false;
    this.speedUpStartTime = null;
  }

  // ====== 1. 【修正點】補回遺失的 initWithHorses ======
  /**
   * 初始化馬匹陣列、基準速度
   * @param {Array<Object>} horses - 馬匹物件陣列
   */
  initWithHorses(horses) {
    this.horses = horses;
    const N = this.cfg.laneCount;
    // 基準速度 100~120（暖啟動避免 0 速）
    this.baseSpeeds = Array.from({ length: N }, () => 100 + Math.random() * 20);
    this.speedState.v = this.baseSpeeds.slice();
    this.finishedTimes = Array(N).fill(null);
    this.finalRank.length = 0;

    // 重置快照/模式
    this.slowmoSnapshotV = Array(N).fill(null);
    this.postFinishSpeedUp = false;
    this.speedUpStartTime = null;
  }

  // ====== 2. 回合開始 (startRace 邏輯不變) ======
  startRace(startTime, forcedTop5Rank, durationSec) {
    this.RACE.startTime = startTime;
    this.RACE.durationSec = durationSec ?? this._rand(this.RACE.durationMinSec, this.RACE.durationMaxSec);
    this.RACE.setupDone = true;

    this.SLOWMO.active = false; this.SLOWMO.triggeredAt = null;
    this.lockStage = this.LOCK_STAGE.None;
    this.leader = null;

    this.speedState.v = this.baseSpeeds.slice();

    this._initRhythm();
    this._initSprint();

    const N = this.cfg.laneCount;
    for (let i = 0; i < N; i++) this.finishedTimes[i] = null;
    this.finalRank.length = 0;

    this.forcedTop5Rank = (Array.isArray(forcedTop5Rank) && forcedTop5Rank.length === 5) ? forcedTop5Rank.slice() : null;

    this._flags.firstHorseFinished = false;
    this.postFinishSpeedUp = false;
    this.speedUpStartTime = null;
    this.slowmoSnapshotV = Array(N).fill(null);
  }

  // ====== 3. 每幀更新 (tick 邏輯不變) ======
  tick(dt, t) {
    const elapsed = this._nowSinceStart(t);
    const N = this.cfg.laneCount;

    let dtScale = 1;
    if (!this.postFinishSpeedUp) {
      if (this.SLOWMO.enabled && !this.SLOWMO.active) {
        const pct = this._getLeaderProgress();
        if (pct >= this.SLOWMO.triggerPct) {
          this.SLOWMO.active = true;
          this.SLOWMO.triggeredAt = t;
          for (let i = 0; i < N; i++) {
            const vi = Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i];
            this.slowmoSnapshotV[i] = this.cfg.clamp(vi, this.SPEED_CONF.vMin, this.SPEED_CONF.vMax);
          }
        }
      }
      dtScale = (this.SLOWMO.active ? this.SLOWMO.rate : 1);
    }

    this._updateLockStage();

    const isPostFinish = this.postFinishSpeedUp;
    if (!isPostFinish) this._tryTriggerSprint(elapsed);
    this._updateSprintLifecycle(elapsed);

    const isLocking = (!isPostFinish) && this._inAnyLock();
    const stageGain = (this.lockStage === this.LOCK_STAGE.PreLock) ? this.LOCK.gain.Pre
      : (this.lockStage === this.LOCK_STAGE.LockStrong) ? this.LOCK.gain.Strong
        : (this.lockStage === this.LOCK_STAGE.FinishGuard) ? this.LOCK.gain.Guard
          : null;

    const currOrder = this._computeCurrentOrderIdx();
    const currRankMap = {};
    for (let r = 0; r < currOrder.length; r++) currRankMap[currOrder[r]] = r + 1;

    const desiredOrder = (this.forcedTop5Rank && (isLocking || isPostFinish)) ? this._computeDesiredOrder() : currOrder.slice();
    const desiredRankMap = {};
    for (let r = 0; r < desiredOrder.length; r++) desiredRankMap[desiredOrder[r]] = r + 1;
    const xTarget = (isLocking || isPostFinish) ? this._computeShadowTargets(desiredOrder) : null;

    const nextV = Array(N).fill(0);

    for (let i = 0; i < N; i++) {
      const p = this._getHorse(i); if (!p) continue;

      if (this.finishedTimes[i] != null) {
        nextV[i] = Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i];
        continue;
      }

      if (isPostFinish) {
        const slowmoV = this.slowmoSnapshotV[i] || this.speedState.v[i];
        const normalV = this.baseSpeeds[i];
        const tElapsed = t - this.speedUpStartTime;
        const speedUpDur = 2.0;
        const tNorm = this.cfg.clamp(tElapsed / speedUpDur, 0, 1);

        let vStar = this.cfg.lerp(slowmoV, normalV, tNorm);

        if (this.forcedTop5Rank) {
          const stageGainGuard = this.LOCK.gain.Guard;
          const factor = this._lockSpeedFactorFor(i, stageGainGuard, desiredRankMap, currRankMap, xTarget);
          vStar *= factor;
        }

        vStar = this.cfg.clamp(vStar, this.SPEED_CONF.vMin, this.SPEED_CONF.vMax);
        nextV[i] = vStar;

      } else {
        const noiseScale = isLocking ? this.SPEED_CONF.noiseScaleLock
          : this._inPhase('setup', elapsed) ? this.SPEED_CONF.noiseScaleSetup
            : this.SPEED_CONF.noiseScaleStart;

        let vStar = this.baseSpeeds[i];

        const m = this._updateRhythm(i, elapsed);
        vStar *= m;

        if (this._isMidOrSetup(elapsed) && this._isSprinting(i)) {
          const mult = this._rand(this.SPRINT.multMin, this.SPRINT.multMax);
          vStar *= mult;
        }

        if (this.forcedTop5Rank && isLocking && stageGain) {
          const factor = this._lockSpeedFactorFor(i, stageGain, desiredRankMap, currRankMap, xTarget);
          vStar *= factor;
        }
        
        if (isLocking && !this.forcedTop5Rank) {
             vStar *= 1.05; 
        }

        if (this.lockStage === this.LOCK_STAGE.LockStrong && this.LOCK.noSpeedLimitInStrong) {
          vStar = Math.max(this.SPEED_CONF.vMin, vStar);
        } else {
          vStar = this.cfg.clamp(vStar, this.SPEED_CONF.vMin, this.SPEED_CONF.vMax);
        }

        const vPrev = Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i];
        const vNow = vPrev + (vStar - vPrev) * this.SPEED_CONF.blend;
        nextV[i] = vNow;

        p.group.position.y = Math.max(0, Math.abs(this.cfg.noise(t, i)) * 0.2 * noiseScale);
      }
    }

    if (isLocking || isPostFinish) this._applySoftSeparation(currOrder, nextV, desiredRankMap);
    
    let firstJustFinished = false;
    for (let i = 0; i < N; i++) {
      const p = this._getHorse(i); if (!p) continue;
      this.speedState.v[i] = nextV[i];
      const vVisual = nextV[i] * dtScale;
      const maxV = this.SPEED_CONF.vMax; 
      const pct = this.cfg.clamp(vVisual / Math.max(1e-6, maxV), 0, 1);
      const animSpeed = pct * 7;
      if (typeof p?.setAnimationSpeed === 'function') {
        p.setAnimationSpeed(animSpeed);
      }
      p.group.position.x += nextV[i] * dt * dtScale;
      p.update(dt * dtScale);

      if (this.finishedTimes[i] == null && p.group.position.x >= this.cfg.finishDetectX) {
        this._stampFinish(i, t);
        if (!firstJustFinished) firstJustFinished = true;
      }
    }

    if (!this._everyoneFinished()) {
      const newL = this._computeLeader();
      if (newL && newL !== this.leader) this.leader = newL;
    }

    if (firstJustFinished) {
      this._flags.firstHorseFinished = true;
      if (this.SLOWMO.active) {
        this.SLOWMO.active = false;
        this.postFinishSpeedUp = true;
        this.speedUpStartTime = t;
        if (this.lockStage === this.LOCK_STAGE.PreLock || this.lockStage === this.LOCK_STAGE.LockStrong) {
          this.lockStage = this.LOCK_STAGE.FinishGuard;
        }
      }
    }

    return { firstHorseJustFinished: firstJustFinished, everyoneFinished: this._everyoneFinished() };
  }

  // ====== 4. 強制排名與位置修正邏輯 (posFactor 限制已應用) ======

  _lockSpeedFactorFor(i, stageGain, desiredRankMap, currentRankMap, xTarget) {
    const currRank = currentRankMap[i];
    const wantRank = desiredRankMap[i];
    const eRank = currRank - wantRank;

    let rankFactor;
    if (eRank > 0) rankFactor = 1 + stageGain.boost * eRank;
    else if (eRank < 0) rankFactor = 1 / (1 + stageGain.brake * Math.abs(eRank));
    else rankFactor = 1;

    const x = this._getHorseX(i);
    const xt = xTarget[wantRank];
    const ePos = xt - x;
    
    // 【應用 posFactor 限制】
    const posFactorRaw = 1 + stageGain.pos * ePos;
    const posFactor = this.cfg.clamp(posFactorRaw, 0.4, this.LOCK.MAX_POS_FACTOR); 

    const inTop5 = this.forcedTop5Rank ? this.forcedTop5Rank.map(n => this.cfg.clamp((n | 0) - 1, 0, this.cfg.laneCount - 1)).includes(i) : false;
    const currTop5 = currRank <= 5;
    let forcedFactor = 1;
    
    if (!inTop5 && currTop5) {
      const severity = (6 - currRank);
      forcedFactor = 1 / (1 + stageGain.forcedBrake * Math.max(0, severity));
    } else if (inTop5 && currRank > 5) {
      const severity = (currRank - 5);
      forcedFactor = 1 + stageGain.forcedBoost * Math.max(0, severity);
    }
    
    const finalFactor = this.cfg.clamp(rankFactor * posFactor * forcedFactor, 0.25, 3.5);

    return finalFactor;
  }
  
  // ====== 5. 輔助函數 (為確保完整性，全部保留) ======
  
  _getHorse(i) { return this.horses[i]?.player || this.horses[i]; }
  _getHorseX(iOrHorse) {
    const p = (typeof iOrHorse === 'number') ? this._getHorse(iOrHorse) : (iOrHorse?.player || iOrHorse);
    return p?.group?.position?.x ?? 0;
  }
  _rand(a, b) { return this.cfg.randFloat(a, b); }
  _nowSinceStart(t) { return (this.RACE.startTime == null) ? 0 : Math.max(0, t - this.RACE.startTime); }
  _timePct(elapsed) { return (!this.RACE.durationSec) ? 0 : this.cfg.clamp(elapsed / this.RACE.durationSec, 0, 2); }
  _inPhase(name, elapsed) {
    const t = this._timePct(elapsed);
    if (name === 'start') return t < this.PHASE_SPLITS.start;
    if (name === 'mid') return t >= this.PHASE_SPLITS.start && t < this.PHASE_SPLITS.setup;
    if (name === 'setup') return t >= this.PHASE_SPLITS.setup && t < this.PHASE_SPLITS.lock;
    if (name === 'lock') return t >= this.PHASE_SPLITS.lock;
    return false;
  }
  _isMidOrSetup(elapsed) { return this._inPhase('mid', elapsed) || this._inPhase('setup', elapsed); }
  _computeLeader() {
    let maxX = -Infinity, best = -1;
    for (let i = 0; i < this.horses.length; i++) {
      const x = this._getHorseX(i);
      if (x > maxX) { maxX = x; best = i; }
    }
    return best >= 0 ? this.horses[best] : null;
  }
  _computeCurrentOrderIdx() {
    const N = this.cfg.laneCount;
    const idx = [...Array(N).keys()];
    idx.sort((a, b) => this._getHorseX(b) - this._getHorseX(a));
    return idx;
  }
  _everyoneFinished() { return this.finishedTimes.every(t => t != null); }
  _stampFinish(i, t) {
    if (this.finishedTimes[i] != null) return;
    this.finishedTimes[i] = t;
    const horseNo = i + 1;
    this.finalRank.push(horseNo);
  }
  _getLeaderProgress() {
    const leadObj = this.leader || this._computeLeader();
    if (!leadObj) return 0;
    const x = this._getHorseX(leadObj);
    const pct = (x - this.cfg.startLineX) / (this.cfg.finishLineX - this.cfg.startLineX);
    return THREE.MathUtils.clamp(pct, 0, 1.5);
  }
  _updateLockStage() {
    const pct = this._getLeaderProgress();
    if (this.lockStage === this.LOCK_STAGE.None) {
      if (pct >= this.LOCK.preTriggerPct && pct < this.LOCK.triggerPct) this.lockStage = this.LOCK_STAGE.PreLock;
      if (pct >= this.LOCK.triggerPct) this.lockStage = this.LOCK_STAGE.LockStrong;
    } else if (this.lockStage === this.LOCK_STAGE.PreLock) {
      if (pct >= this.LOCK.triggerPct) this.lockStage = this.LOCK_STAGE.LockStrong;
      else if (pct < this.LOCK.releasePct) this.lockStage = this.LOCK_STAGE.None;
    }
  }
  _inAnyLock() { return this.lockStage !== this.LOCK_STAGE.None; }
  _dynamicMinGap() {
    const prog = this.cfg.clamp(this._getLeaderProgress(), 0, 1);
    const a = this.cfg.clamp((prog - this.LOCK.gapWidenFrom) / Math.max(1e-3, this.LOCK.gapWidenTo - this.LOCK.gapWidenFrom), 0, 1);
    return this.cfg.lerp(this.LOCK.minGapBase, this.LOCK.minGapMax, a);
  }
  _computeDesiredOrder() {
    if (!this.forcedTop5Rank) return this._computeCurrentOrderIdx();
    const top5Idx = this.forcedTop5Rank.map(n => this.cfg.clamp((n | 0) - 1, 0, this.cfg.laneCount - 1));
    const set = new Set(top5Idx);
    const others = [];
    for (let i = 0; i < this.cfg.laneCount; i++) if (!set.has(i)) others.push(i);
    others.sort((a, b) => this._getHorseX(b) - this._getHorseX(a));
    return top5Idx.concat(others);
  }
  _computeShadowTargets(desiredOrder) {
    const delta = this._dynamicMinGap();
    const anchor = this.cfg.finishLineX - 0.25;
    const xTarget = Array(desiredOrder.length + 1).fill(anchor);
    for (let k = 2; k <= desiredOrder.length; k++) xTarget[k] = xTarget[k - 1] - delta;
    return xTarget;
  }
  _applySoftSeparation(currentOrderIdx, velocities, desiredRankMap) {
    const delta = this._dynamicMinGap();
    for (let r = 1; r < currentOrderIdx.length; r++) {
      const iF = currentOrderIdx[r];
      const iL = currentOrderIdx[r - 1];
      const xF = this._getHorseX(iF);
      const xL = this._getHorseX(iL);
      if (xF > xL - delta) {
        const shouldOvertake =
          this.forcedTop5Rank && desiredRankMap && desiredRankMap[iF] != null && desiredRankMap[iL] != null &&
          desiredRankMap[iF] < desiredRankMap[iL];

        if (shouldOvertake) {
          velocities[iL] = Math.max(0, velocities[iL] * 0.96);
        } else {
          velocities[iF] = Math.min(velocities[iF], Math.max(0, velocities[iL] * 0.92));
        }
      }
    }
  }
  _initSprint() {
    const N = this.cfg.laneCount;
    this.sprintState = {
      active: Array(N).fill(false), until: Array(N).fill(0),
      lastEndAt: Array(N).fill(-999), usedTimes: Array(N).fill(0),
    };
  }
  _isSprinting(i) { return !!this.sprintState.active[i]; }
  _tryTriggerSprint(nowSec) {
    if (this._inAnyLock()) return;
    if (!(this._inPhase('mid', nowSec) || this._inPhase('setup', nowSec))) return;

    const order = this._computeCurrentOrderIdx();
    for (let rank = 1; rank < order.length; rank++) {
      const i = order[rank];
      const j = order[rank - 1];
      const myX = this._getHorseX(i);
      const tgtX = this._getHorseX(j);
      const gap = tgtX - myX;

      if (this.sprintState.active[i]) continue;
      if (this.sprintState.usedTimes[i] >= this.SPRINT.maxTimesPerHorse) continue;
      if (nowSec - this.sprintState.lastEndAt[i] < this.SPRINT.cooldownSec) continue;
      if (gap < this.SPRINT.gapMin || gap > this.SPRINT.gapMax) continue;

      const myV = Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i];
      const tgtV = Number.isFinite(this.speedState.v[j]) ? this.speedState.v[j] : this.baseSpeeds[j];
      const want = (myV <= tgtV) || (Math.random() < 0.35);
      if (!want) continue;

      const dur = this._rand(this.SPRINT.durMin, this.SPRINT.durMax);
      this.sprintState.active[i] = true;
      this.sprintState.until[i] = nowSec + dur;
      this.sprintState.usedTimes[i] += 1;
    }
  }
  _updateSprintLifecycle(nowSec) {
    for (let i = 0; i < this.cfg.laneCount; i++) {
      if (this.sprintState.active[i] && nowSec >= this.sprintState.until[i]) {
        this.sprintState.active[i] = false;
        this.sprintState.lastEndAt[i] = nowSec;
      }
    }
  }

  _initRhythm() {
    const N = this.cfg.laneCount;
    this.rhythmState = {
      segFrom: Array(N).fill(1.0), segTo: Array(N).fill(1.0),
      segT0: Array(N).fill(0), segT1: Array(N).fill(0),
      burstAmp: Array(N).fill(0), burstT0: Array(N).fill(-999),
      burstUntil: Array(N).fill(-999), lastBurstEnd: Array(N).fill(-999),
    };
    for (let i = 0; i < N; i++) {
      this.rhythmState.segTo[i] = this._rand(this.RHYTHM_CONF.segment.multMin, this.RHYTHM_CONF.segment.multMax);
      const dur = this._rand(this.RHYTHM_CONF.segment.durMin, this.RHYTHM_CONF.segment.durMax);
      this.rhythmState.segT0[i] = 0;
      this.rhythmState.segT1[i] = dur;
    }
  }
  _ensureNextSegment(i, nowSec) {
    if (nowSec < this.rhythmState.segT1[i]) return;
    const from = this.rhythmState.segTo[i];
    const to = this._rand(this.RHYTHM_CONF.segment.multMin, this.RHYTHM_CONF.segment.multMax);
    const dur = this._rand(this.RHYTHM_CONF.segment.durMin, this.RHYTHM_CONF.segment.durMax);
    this.rhythmState.segFrom[i] = from;
    this.rhythmState.segTo[i] = to;
    this.rhythmState.segT0[i] = nowSec;
    this.rhythmState.segT1[i] = nowSec + dur;
  }
  _evalSegmentMultiplier(i, nowSec) {
    const t0 = this.rhythmState.segT0[i], t1 = this.rhythmState.segT1[i];
    const from = this.rhythmState.segFrom[i], to = this.rhythmState.segTo[i];
    const dur = Math.max(0.001, t1 - t0);
    const x = this.cfg.clamp((nowSec - t0) / dur, 0, 1);
    const easeWindow = this.RHYTHM_CONF.segment.easeSec / dur;
    const eased = (x < easeWindow) ? (x / Math.max(1e-4, easeWindow)) : x;
    const e = (eased < 0.5) ? 4 * eased ** 3 : 1 - Math.pow(-2 * eased + 2, 3) / 2;
    return this.cfg.lerp(from, to, e);
  }
  _maybeTriggerBurst(i, nowSec) {
    if (nowSec - this.rhythmState.lastBurstEnd[i] < this.RHYTHM_CONF.burst.cooldownSec) return;
    if (this._inAnyLock()) return;
    const prob = this.RHYTHM_CONF.burst.probPerSec * (1 / 60);
    if (Math.random() < prob) {
      this.rhythmState.burstAmp[i] = this._rand(this.RHYTHM_CONF.burst.ampMin, this.RHYTHM_CONF.burst.ampMax);
      this.rhythmState.burstT0[i] = nowSec;
      this.rhythmState.burstUntil[i] = nowSec + this.RHYTHM_CONF.burst.durSec;
      this.rhythmState.lastBurstEnd[i] = this.rhythmState.burstUntil[i];
    }
  }
  _evalBurstMultiplier(i, nowSec) {
    const t0 = this.rhythmState.burstT0[i], t1 = this.rhythmState.burstUntil[i];
    if (nowSec > t1) return 0;
    const a = this.rhythmState.burstAmp[i];
    const x = this.cfg.clamp((nowSec - t0) / Math.max(0.001, t1 - t0), 0, 1);
    if (x < 0.2) return a * (x / 0.2);
    const y = (x - 0.2) / 0.8;
    const easeOut = 1 - Math.pow(1 - y, 3);
    return a * (1 - easeOut);
  }
  _rhythmWeightNow(elapsed) {
    if (this._inAnyLock()) return 0.05;
    if (this._inPhase('setup', elapsed)) return this.RHYTHM_CONF.weightByPhase.setup;
    if (this._inPhase('mid', elapsed)) return this.RHYTHM_CONF.weightByPhase.mid;
    return this.RHYTHM_CONF.weightByPhase.start;
  }
  _updateRhythm(i, elapsed) {
    this._ensureNextSegment(i, elapsed);
    this._maybeTriggerBurst(i, elapsed);
    const segMul = this._evalSegmentMultiplier(i, elapsed);
    const burst = this._evalBurstMultiplier(i, elapsed);
    let m = segMul * (1 + burst);
    m = this.cfg.clamp(m, this.RHYTHM_CONF.bounds.min, this.RHYTHM_CONF.bounds.max);
    const w = this._rhythmWeightNow(elapsed);
    return this.cfg.lerp(1.0, m, w);
  }

  // 對外查詢 (不變)
  getFinalRank() { return this.finalRank.slice(); }
  getFinishedTimes() { return this.finishedTimes.slice(); }
  getLockStage() { return this.lockStage; }
  isSlowMoActive() { return !!this.SLOWMO.active; }
  isEveryoneFinished() { return this._everyoneFinished(); }
  getLeader() { return this.leader; }
  getCurrentOrderIdx() { return this._computeCurrentOrderIdx(); }
  getSpeedState() { return this.speedState; }
}