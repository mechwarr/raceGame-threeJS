// 系統：賽跑邏輯引擎（抽離版）— 控制馬匹速度/名次收斂/完賽判定/SlowMo/Lock/Sprint/Rhythm
// 變更摘要：
// - 在 SlowMo 觸發當幀，為每匹馬建立速度快照 slowmoSnapshotV[]；
// - 第一匹越線當幀關閉 SlowMo，進入 postSlowMoFrozen 鎖速模式；
// - 在鎖速模式下直到 everyoneFinished() 之前：未完賽馬用快照速度推進，已完賽馬維持現速；
// - 不再在鎖速狀態內套用 rhythm / sprint / lock 名次回授等速度演算。

import * as THREE from 'https://unpkg.com/three@0.165.0/build/three.module.js';

export class RaceEngine {
  /**
   * @param {{ laneCount:number, startLineX:number, finishLineX:number, finishDetectX:number,
   *           noise:(t:number,i:number)=>number, randFloat:(a:number,b:number)=>number, clamp:(v,a,b)=>number, lerp:(a,b,t)=>number,
   *           log?:Function }} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.log = cfg.log || (()=>{});

    // ===== 參數（沿用既有） =====
    this.SLOWMO = { enabled: true, triggerPct: 0.90, rate: 0.3, active: false, triggeredAt: null };
    this.LOCK_STAGE = { None:'None', PreLock:'PreLock', LockStrong:'LockStrong', FinishGuard:'FinishGuard' };
    this.LOCK = {
      preTriggerPct: 0.70, triggerPct: 0.75, releasePct: 0.72,
      minGapBase: 0.60, minGapMax: 1.20, gapWidenFrom: 0.90, gapWidenTo: 1.00,
      gain: {
        Pre:    { boost:0.20, brake:0.15, pos:0.020, forcedBoost:0.60, forcedBrake:0.80 },
        Strong: { boost:0.90, brake:0.70, pos:0.050, forcedBoost:1.20, forcedBrake:1.20 },
        Guard:  { boost:0.30, brake:0.25, pos:0.030, forcedBoost:0.80, forcedBrake:0.90 },
      },
      noSpeedLimitInStrong: true,
    };
    this.SPEED_CONF = { vMin:60, vMax:180, blend:0.10, noiseScaleStart:1.0, noiseScaleSetup:0.4, noiseScaleLock:0.2 };
    this.PHASE_SPLITS = { start:0.60, setup:0.85, lock:0.97 };
    this.RHYTHM_CONF = {
      segment:{ durMin:0.9, durMax:1.4, multMin:0.20, multMax:3.0, easeSec:0.25 },
      burst:{ probPerSec:0.45, ampMin:0.06, ampMax:0.10, durSec:0.8, cooldownSec:0.6 },
      weightByPhase:{ start:1.00, mid:1.00, setup:0.30, lock:0.12 },
      bounds:{ min:0.75, max:1.35 },
    };
    this.SPRINT = {
      cooldownSec:3.0, durMin:0.8, durMax:1.6, multMin:1.15, multMax:1.25,
      maxTimesPerHorse:1, gapMin:2.0, gapMax:10.0,
    };

    // ===== 內部狀態 =====
    this.horses = [];
    this.baseSpeeds = [];
    this.speedState = { v: [] };
    this.rhythmState = null;
    this.sprintState = null;

    this.RACE = { durationMinSec:22, durationMaxSec:28, durationSec:null, startTime:null, setupDone:false };
    this.finishSchedule = { T: [] };      // 預定完賽時間（絕對 t）
    this.finishedTimes = [];              // 實際越線時間（絕對 t）
    this.finalRank = [];                  // 固定名次（馬號 1..N）
    this.lockStage = this.LOCK_STAGE.None;
    this.leader = null;
    this.forcedTop5Rank = null;

    this._flags = { firstHorseFinished:false };

    // ===== 新增：SlowMo 速度快照 / 鎖速模式 =====
    this.slowmoSnapshotV = [];   // 在 SlowMo 觸發當幀記錄各馬的速度
    this.postSlowMoFrozen = false; // 第一匹越線後，直到 everyoneFinished 前的鎖速旗標
  }

  // ====== 初始化馬匹陣列、基準速度 ======
  initWithHorses(horses) {
    this.horses = horses;
    const N = this.cfg.laneCount;
    // 基準速度 100~120（暖啟動避免 0 速）
    this.baseSpeeds = Array.from({length:N}, () => 100 + Math.random()*20);
    this.speedState.v = this.baseSpeeds.slice();
    this.finishSchedule.T = Array(N).fill(null);
    this.finishedTimes   = Array(N).fill(null);
    this.finalRank.length = 0;

    // 也重置快照/鎖速
    this.slowmoSnapshotV = Array(N).fill(null);
    this.postSlowMoFrozen = false;
  }

  // ====== 回合開始 ======
  startRace(startTime, forcedTop5Rank, durationSec) {
    this.RACE.startTime = startTime;
    this.RACE.durationSec = durationSec ?? this._rand(this.RACE.durationMinSec, this.RACE.durationMaxSec);
    this.RACE.setupDone = false;

    // SlowMo/Lock
    this.SLOWMO.active = false; this.SLOWMO.triggeredAt = null;
    this.lockStage = this.LOCK_STAGE.None;
    this.leader = null;

    // 暖啟動速度回復至 base（避免 0 或上局殘值）
    this.speedState.v = this.baseSpeeds.slice();

    // Rhythm / Sprint
    this._initRhythm();
    this._initSprint();

    // 完賽表、紀錄清空
    const N = this.cfg.laneCount;
    this.finishSchedule.T.fill(null);
    for (let i=0;i<N;i++) this.finishedTimes[i] = null;
    this.finalRank.length = 0;

    // 指定前五
    this.forcedTop5Rank = (Array.isArray(forcedTop5Rank) && forcedTop5Rank.length === 5) ? forcedTop5Rank.slice() : null;

    // 旗標/快照重置
    this._flags.firstHorseFinished = false;
    this.postSlowMoFrozen = false;
    this.slowmoSnapshotV = Array(N).fill(null);
  }

  // ====== 每幀更新（Running / Finished(未全到線)）======
  /**
   * @param {number} dt - delta time
   * @param {number} t  - clock.elapsedTime
   * @returns {{firstHorseJustFinished:boolean, everyoneFinished:boolean}}
   */
  tick(dt, t) {
    // 觸發 SlowMo（與 Lock 解耦）
    if (this.SLOWMO.enabled && !this.SLOWMO.active) {
      const pct = this._getLeaderProgress();
      if (pct >= this.SLOWMO.triggerPct) {
        this.SLOWMO.active = true;
        this.SLOWMO.triggeredAt = t;
        //this.log?.(`[SlowMo] triggered at ${Math.round(pct*100)}% (rate=${this.SLOWMO.rate})`);

        // ★ 新增：建立 SlowMo 當幀「速度快照」
        const N = this.cfg.laneCount;
        for (let i=0;i<N;i++){
          const vi = Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i];
          this.slowmoSnapshotV[i] = this.cfg.clamp(vi, this.SPEED_CONF.vMin, this.SPEED_CONF.vMax);
        }
      }
    }
    const dtScale = (this.SLOWMO.active ? this.SLOWMO.rate : 1);

    // Lock 階段更新
    this._updateLockStage();

    const elapsed = this._nowSinceStart(t);

    // 鎖速模式下：停止一切主動速度演算（但仍更新 Sprint 狀態時鐘以免殘留）
    if (!this.postSlowMoFrozen) {
      this._tryTriggerSprint(elapsed);
    }
    this._updateSprintLifecycle(elapsed);

    // Setup：產生完賽時程表（含前五）
    if (!this.postSlowMoFrozen && this._inPhase('setup', elapsed)) {
      this._buildFinishScheduleIfNeeded(t);
    }

    // 排序資訊（當前與期望）
    const isLocking = (!this.postSlowMoFrozen) && this._inAnyLock();
    const stageGain = (this.lockStage === this.LOCK_STAGE.PreLock) ? this.LOCK.gain.Pre
      : (this.lockStage === this.LOCK_STAGE.LockStrong) ? this.LOCK.gain.Strong
      : (this.lockStage === this.LOCK_STAGE.FinishGuard) ? this.LOCK.gain.Guard
      : null;

    const currOrder = this._computeCurrentOrderIdx();
    const currRankMap = {};
    for (let r=0;r<currOrder.length;r++) currRankMap[currOrder[r]] = r+1;

    const desiredOrder = (this.forcedTop5Rank && isLocking) ? this._computeDesiredOrder() : currOrder.slice();
    const desiredRankMap = {};
    for (let r=0;r<desiredOrder.length;r++) desiredRankMap[desiredOrder[r]] = r+1;
    const xTarget = (isLocking) ? this._computeShadowTargets(desiredOrder) : null;

    // 計算速度
    const N = this.cfg.laneCount;
    const nextV = Array(N).fill(0);

    for (let i=0;i<N;i++){
      const p = this._getHorse(i); if (!p) continue;

      // 已越線：維持當前速度（不再進入速度控制）
      if (this.finishedTimes[i] != null) {
        nextV[i] = Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i];
        continue;
      }

      // ★ 鎖速模式：未完賽者用 SlowMo 快照速度，完全不跑任何速度演算
      if (this.postSlowMoFrozen) {
        const vFrozen = Number.isFinite(this.slowmoSnapshotV[i]) ? this.slowmoSnapshotV[i] : (Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i]);
        nextV[i] = this.cfg.clamp(vFrozen, this.SPEED_CONF.vMin, this.SPEED_CONF.vMax);

        // 視覺噪聲（可留）：保持 y 微抖動
        p.group.position.y = Math.max(0, Math.abs(this.cfg.noise(t, i)) * 0.2 * this.SPEED_CONF.noiseScaleLock);
        continue;
      }

      // —— 以下為正常演算（非鎖速模式）——

      // 噪聲權重
      const noiseScale = isLocking ? this.SPEED_CONF.noiseScaleLock
        : this._inPhase('setup', elapsed) ? this.SPEED_CONF.noiseScaleSetup
        : this.SPEED_CONF.noiseScaleStart;

      // v*：Setup 後用 剩距/剩時；否則用 base
      let vStar;
      if (this.RACE.setupDone && this.finishSchedule.T[i] != null) {
        const x = p.group.position.x;
        const d = Math.max(0, this.cfg.finishLineX - x);
        const tau = Math.max(0.01, this.finishSchedule.T[i] - t);
        vStar = d / tau;
      } else {
        vStar = this.baseSpeeds[i];
      }

      // 節奏倍率
      const m = this._updateRhythm(i, elapsed);
      vStar *= m;

      // Lock 名次回授（含 forcedTop5）
      if (this.forcedTop5Rank && isLocking && stageGain) {
        const factor = this._lockSpeedFactorFor(i, stageGain, desiredRankMap, currRankMap, xTarget);
        vStar *= factor;
      } else {
        // 非 Lock：中段/Setup 的 Sprint
        if (this._isMidOrSetup(elapsed) && this._isSprinting(i)) {
          const mult = this._rand(this.SPRINT.multMin, this.SPRINT.multMax);
          vStar *= mult;
        }
      }

      // 夾限：LockStrong 可取消上限
      if (this.lockStage === this.LOCK_STAGE.LockStrong && this.LOCK.noSpeedLimitInStrong) {
        vStar = Math.max(this.SPEED_CONF.vMin, vStar);
      } else {
        vStar = this.cfg.clamp(vStar, this.SPEED_CONF.vMin, this.SPEED_CONF.vMax);
      }

      // 平滑靠攏
      const vPrev = Number.isFinite(this.speedState.v[i]) ? this.speedState.v[i] : this.baseSpeeds[i];
      const vNow = vPrev + (vStar - vPrev) * this.SPEED_CONF.blend;
      nextV[i] = vNow;

      // Y 視覺噪聲
      p.group.position.y = Math.max(0, Math.abs(this.cfg.noise(t, i)) * 0.2 * noiseScale);
    }

    // 鎖速模式下不再執行安全間距或名次微調；若你想保留，可在此以極小係數處理
    if (isLocking) this._applySoftSeparation(currOrder, nextV, desiredRankMap);

    // 套用速度、推進、動畫、越線判定
    let firstJustFinished = false;
    for (let i=0;i<N;i++){
      const p = this._getHorse(i); if (!p) continue;
      this.speedState.v[i] = nextV[i];

      // SlowMo 時間縮放只在 SLOWMO.active 為真時套用
      p.group.position.x += nextV[i] * dt * (this.SLOWMO.active ? this.SLOWMO.rate : 1);
      p.update(dt * (this.SLOWMO.active ? this.SLOWMO.rate : 1));

      if (this.finishedTimes[i] == null && p.group.position.x >= this.cfg.finishDetectX) {
        this._stampFinish(i, t);
        if (!firstJustFinished) firstJustFinished = true;
      }
    }

    // 領先者（僅在未全員到線時更新）
    if (!this._everyoneFinished()) {
      const newL = this._computeLeader();
      if (newL && newL !== this.leader) this.leader = newL;
    }

    // ★ 第一名抵達後：關閉 SlowMo 並進入鎖速模式（直到全員到線）
    if (firstJustFinished) {
      this._flags.firstHorseFinished = true;

      if (this.SLOWMO.active) {
        this.SLOWMO.active = false;
        //this.log?.('[SlowMo] deactivated (first horse finished)');
      }

      // 進入鎖速模式
      this.postSlowMoFrozen = true;

      // 如在 Lock 流程，切到 FinishGuard（語意：維持秩序到全員到線）
      if (this.lockStage === this.LOCK_STAGE.PreLock || this.lockStage === this.LOCK_STAGE.LockStrong) {
        this.lockStage = this.LOCK_STAGE.FinishGuard;
        //this.log?.('[Lock] FinishGuard (maintain order until all finished)');
      }
    }

    return { firstHorseJustFinished:firstJustFinished, everyoneFinished:this._everyoneFinished() };
  }

  // ===== 對外查詢 =====
  getFinalRank() { return this.finalRank.slice(); }
  getFinishedTimes() { return this.finishedTimes.slice(); }
  getLockStage() { return this.lockStage; }
  isSlowMoActive() { return !!this.SLOWMO.active; }
  isEveryoneFinished() { return this._everyoneFinished(); }
  getLeader() { return this.leader; }
  getCurrentOrderIdx() { return this._computeCurrentOrderIdx(); }
  getSpeedState() { return this.speedState; }

  // ====== 私有工具 ======
  _getHorse(i){ return this.horses[i]?.player || this.horses[i]; }
  _getHorseX(iOrHorse){
    const p = (typeof iOrHorse==='number') ? this._getHorse(iOrHorse) : (iOrHorse?.player || iOrHorse);
    return p?.group?.position?.x ?? 0;
  }
  _rand(a,b){ return this.cfg.randFloat(a,b); }
  _nowSinceStart(t) { return (this.RACE.startTime==null) ? 0 : Math.max(0, t - this.RACE.startTime); }
  _timePct(elapsed){ return (!this.RACE.durationSec) ? 0 : this.cfg.clamp(elapsed / this.RACE.durationSec, 0, 2); }
  _inPhase(name, elapsed){
    const t = this._timePct(elapsed);
    if (name==='start') return t < this.PHASE_SPLITS.start;
    if (name==='mid')   return t >= this.PHASE_SPLITS.start && t < this.PHASE_SPLITS.setup;
    if (name==='setup') return t >= this.PHASE_SPLITS.setup && t < this.PHASE_SPLITS.lock;
    if (name==='lock')  return t >= this.PHASE_SPLITS.lock;
    return false;
  }
  _isMidOrSetup(elapsed){ return this._inPhase('mid', elapsed) || this._inPhase('setup', elapsed); }

  _computeLeader(){
    let maxX=-Infinity, best=-1;
    for (let i=0;i<this.horses.length;i++){
      const x = this._getHorseX(i);
      if (x>maxX){ maxX=x; best=i; }
    }
    return best>=0 ? this.horses[best] : null;
  }
  _computeCurrentOrderIdx(){
    const N = this.cfg.laneCount;
    const idx = [...Array(N).keys()];
    idx.sort((a,b)=> this._getHorseX(b) - this._getHorseX(a));
    return idx;
  }
  _everyoneFinished(){ return this.finishedTimes.every(t=>t!=null); }

  _stampFinish(i, t){
    if (this.finishedTimes[i] != null) return;
    this.finishedTimes[i] = t;
    const horseNo = i+1;
    this.finalRank.push(horseNo);
    this.log?.(`[Finish] ${horseNo}`);
  }

  _getLeaderProgress(){
    const leadObj = this.leader || this._computeLeader();
    if (!leadObj) return 0;
    const x = this._getHorseX(leadObj);
    const pct = (x - this.cfg.startLineX) / (this.cfg.finishLineX - this.cfg.startLineX);
    return THREE.MathUtils.clamp(pct, 0, 1.5);
  }

  _updateLockStage(){
    const pct = this._getLeaderProgress();
    if (this.lockStage === this.LOCK_STAGE.None){
      if (pct >= this.LOCK.preTriggerPct && pct < this.LOCK.triggerPct) this.lockStage = this.LOCK_STAGE.PreLock;
      if (pct >= this.LOCK.triggerPct) this.lockStage = this.LOCK_STAGE.LockStrong;
    } else if (this.lockStage === this.LOCK_STAGE.PreLock){
      if (pct >= this.LOCK.triggerPct) this.lockStage = this.LOCK_STAGE.LockStrong;
      else if (pct < this.LOCK.releasePct) this.lockStage = this.LOCK_STAGE.None;
    }
  }
  _inAnyLock(){ return this.lockStage !== this.LOCK_STAGE.None; }

  _dynamicMinGap(){
    const prog = this.cfg.clamp(this._getLeaderProgress(), 0, 1);
    const a = this.cfg.clamp((prog - this.LOCK.gapWidenFrom) / Math.max(1e-3, this.LOCK.gapWidenTo - this.LOCK.gapWidenFrom), 0, 1);
    return this.cfg.lerp(this.LOCK.minGapBase, this.LOCK.minGapMax, a);
  }

  _buildFinishScheduleIfNeeded(t){
    if (this.RACE.setupDone || !this.forcedTop5Rank || !this.RACE.durationSec || this.RACE.startTime==null) return;

    const jitter = this._rand(-0.15, 0.15);
    const T1 = this.RACE.startTime + this.RACE.durationSec + jitter;

    // 前五
    const top5Idx = this.forcedTop5Rank.map(n => this.cfg.clamp((n|0)-1, 0, this.cfg.laneCount-1));
    const gaps = [ 0.00, this._rand(0.25,0.45), this._rand(0.45,0.75), this._rand(0.75,1.10), this._rand(1.10,1.60) ];
    for (let k=0;k<5;k++){ this.finishSchedule.T[top5Idx[k]] = T1 + gaps[k]; }

    // 其餘
    const T5 = T1 + gaps[4];
    for (let i=0;i<this.cfg.laneCount;i++){
      if (this.finishSchedule.T[i] != null) continue;
      this.finishSchedule.T[i] = T5 + this._rand(0.5, 4.0);
    }

    // 可行性微調（避免需要超過極限速度）
    for (let i=0;i<this.cfg.laneCount;i++){
      const p = this._getHorse(i); if (!p) continue;
      const x = p.group.position.x;
      const d = Math.max(0, this.cfg.finishLineX - x);
      const tLeft = Math.max(0.01, this.finishSchedule.T[i] - t);
      const vNeed = d / tLeft;
      if (vNeed > this.SPEED_CONF.vMax){
        const extra = (vNeed - this.SPEED_CONF.vMax) / this.SPEED_CONF.vMax;
        this.finishSchedule.T[i] += Math.min(2.0, 0.5 + extra);
      }
    }

    this.RACE.setupDone = true;
    this.log?.('[Setup] Finish schedule generated.');
  }

  _computeDesiredOrder(){
    const top5Idx = this.forcedTop5Rank ? this.forcedTop5Rank.map(n => this.cfg.clamp((n|0)-1, 0, this.cfg.laneCount-1)) : [];
    const set = new Set(top5Idx);
    const others = [];
    for (let i=0;i<this.cfg.laneCount;i++) if (!set.has(i)) others.push(i);

    others.sort((a,b)=>{
      const Ta = this.finishSchedule.T[a] ?? Infinity;
      const Tb = this.finishSchedule.T[b] ?? Infinity;
      if (Ta !== Tb) return Ta - Tb;
      return this._getHorseX(b) - this._getHorseX(a);
    });
    return top5Idx.concat(others);
  }

  _computeShadowTargets(desiredOrder){
    const delta = this._dynamicMinGap();
    const anchor = this.cfg.finishLineX - 0.25;
    const xTarget = Array(desiredOrder.length + 1).fill(anchor);
    for (let k=2;k<=desiredOrder.length;k++) xTarget[k] = xTarget[k-1] - delta;
    return xTarget;
  }

  _lockSpeedFactorFor(i, stageGain, desiredRankMap, currentRankMap, xTarget){
    const currRank = currentRankMap[i];
    const wantRank = desiredRankMap[i];
    const eRank = currRank - wantRank; // >0 落後 應加速；<0 超前 應減速

    let rankFactor;
    if (eRank > 0) rankFactor = 1 + stageGain.boost * eRank;
    else if (eRank < 0) rankFactor = 1 / (1 + stageGain.brake * Math.abs(eRank));
    else rankFactor = 1;

    const x = this._getHorseX(i);
    const xt = xTarget[wantRank];
    const ePos = xt - x; // 正值需更靠前，負值需稍退
    const posFactor = this.cfg.clamp(1 + stageGain.pos * ePos, 0.4, 2.5);

    const inTop5 = this.forcedTop5Rank ? this.forcedTop5Rank.map(n => this.cfg.clamp((n|0)-1, 0, this.cfg.laneCount-1)).includes(i) : false;
    const currTop5 = currRank <= 5;
    let forcedFactor = 1;
    if (!inTop5 && currTop5){
      const severity = (6 - currRank);
      forcedFactor = 1 / (1 + stageGain.forcedBrake * Math.max(0, severity));
    } else if (inTop5 && currRank > 5){
      const severity = (currRank - 5);
      forcedFactor = 1 + stageGain.forcedBoost * Math.max(0, severity);
    }

    return this.cfg.clamp(rankFactor * posFactor * forcedFactor, 0.25, 3.5);
  }

  _applySoftSeparation(currentOrderIdx, velocities, desiredRankMap){
    const delta = this._dynamicMinGap();
    for (let r=1;r<currentOrderIdx.length;r++){
      const iF = currentOrderIdx[r];
      const iL = currentOrderIdx[r-1];
      const xF = this._getHorseX(iF);
      const xL = this._getHorseX(iL);
      if (xF > xL - delta){
        const shouldOvertake =
          desiredRankMap && desiredRankMap[iF]!=null && desiredRankMap[iL]!=null &&
          desiredRankMap[iF] < desiredRankMap[iL]; // 期望排序：後車應在前

        if (shouldOvertake){
          velocities[iL] = Math.max(0, velocities[iL] * 0.96);
        } else {
          velocities[iF] = Math.min(velocities[iF], Math.max(0, velocities[iL] * 0.92));
        }
      }
    }
  }

  // ===== Sprint =====
  _initSprint(){
    const N = this.cfg.laneCount;
    this.sprintState = {
      active:Array(N).fill(false), until:Array(N).fill(0),
      lastEndAt:Array(N).fill(-999), usedTimes:Array(N).fill(0),
    };
  }
  _isSprinting(i){ return !!this.sprintState.active[i]; }
  _tryTriggerSprint(nowSec){
    if (this._inAnyLock()) return;
    if (!(this._inPhase('mid', nowSec) || this._inPhase('setup', nowSec))) return;

    const order = this._computeCurrentOrderIdx();
    for (let rank=1;rank<order.length;rank++){
      const i = order[rank];
      const j = order[rank-1];
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
      this.log?.(`[Sprint] ${i+1} start (dur=${dur.toFixed(2)}s, gap=${gap.toFixed(2)})`);
    }
  }
  _updateSprintLifecycle(nowSec){
    for (let i=0;i<this.cfg.laneCount;i++){
      if (this.sprintState.active[i] && nowSec >= this.sprintState.until[i]){
        this.sprintState.active[i] = false;
        this.sprintState.lastEndAt[i] = nowSec;
        this.log?.(`[Sprint] ${i+1} end`);
      }
    }
  }

  // ===== Rhythm =====
  _initRhythm(){
    const N = this.cfg.laneCount;
    this.rhythmState = {
      segFrom:Array(N).fill(1.0), segTo:Array(N).fill(1.0),
      segT0:Array(N).fill(0), segT1:Array(N).fill(0),
      burstAmp:Array(N).fill(0), burstT0:Array(N).fill(-999),
      burstUntil:Array(N).fill(-999), lastBurstEnd:Array(N).fill(-999),
    };
    for (let i=0;i<N;i++){
      this.rhythmState.segTo[i] = this._rand(this.RHYTHM_CONF.segment.multMin, this.RHYTHM_CONF.segment.multMax);
      const dur = this._rand(this.RHYTHM_CONF.segment.durMin, this.RHYTHM_CONF.segment.durMax);
      this.rhythmState.segT0[i] = 0;
      this.rhythmState.segT1[i] = dur;
    }
  }
  _ensureNextSegment(i, nowSec){
    if (nowSec < this.rhythmState.segT1[i]) return;
    const from = this.rhythmState.segTo[i];
    const to = this._rand(this.RHYTHM_CONF.segment.multMin, this.RHYTHM_CONF.segment.multMax);
    const dur = this._rand(this.RHYTHM_CONF.segment.durMin, this.RHYTHM_CONF.segment.durMax);
    this.rhythmState.segFrom[i] = from;
    this.rhythmState.segTo[i] = to;
    this.rhythmState.segT0[i] = nowSec;
    this.rhythmState.segT1[i] = nowSec + dur;
  }
  _evalSegmentMultiplier(i, nowSec){
    const t0 = this.rhythmState.segT0[i], t1=this.rhythmState.segT1[i];
    const from=this.rhythmState.segFrom[i], to=this.rhythmState.segTo[i];
    const dur = Math.max(0.001, t1-t0);
    const x = this.cfg.clamp((nowSec - t0)/dur, 0, 1);
    const easeWindow = this.RHYTHM_CONF.segment.easeSec / dur;
    const eased = (x < easeWindow) ? (x / Math.max(1e-4, easeWindow)) : x;
    const e = (eased < 0.5) ? 4*eased**3 : 1 - Math.pow(-2*eased+2,3)/2;
    return this.cfg.lerp(from, to, e);
  }
  _maybeTriggerBurst(i, nowSec){
    if (nowSec - this.rhythmState.lastBurstEnd[i] < this.RHYTHM_CONF.burst.cooldownSec) return;
    if (this._inAnyLock()) return;
    const prob = this.RHYTHM_CONF.burst.probPerSec * (1/60);
    if (Math.random() < prob){
      this.rhythmState.burstAmp[i] = this._rand(this.RHYTHM_CONF.burst.ampMin, this.RHYTHM_CONF.burst.ampMax);
      this.rhythmState.burstT0[i] = nowSec;
      this.rhythmState.burstUntil[i] = nowSec + this.RHYTHM_CONF.burst.durSec;
      this.rhythmState.lastBurstEnd[i] = this.rhythmState.burstUntil[i];
    }
  }
  _evalBurstMultiplier(i, nowSec){
    const t0=this.rhythmState.burstT0[i], t1=this.rhythmState.burstUntil[i];
    if (nowSec > t1) return 0;
    const a = this.rhythmState.burstAmp[i];
    const x = this.cfg.clamp((nowSec - t0) / Math.max(0.001, t1 - t0), 0, 1);
    if (x < 0.2) return a * (x/0.2);
    const y = (x-0.2)/0.8;
    const easeOut = 1 - Math.pow(1 - y, 3);
    return a * (1 - easeOut);
  }
  _rhythmWeightNow(elapsed){
    if (this._inAnyLock()) return 0.05;
    if (this._inPhase('setup', elapsed)) return this.RHYTHM_CONF.weightByPhase.setup;
    if (this._inPhase('mid', elapsed)) return this.RHYTHM_CONF.weightByPhase.mid;
    return this.RHYTHM_CONF.weightByPhase.start;
  }
  _updateRhythm(i, elapsed){
    this._ensureNextSegment(i, elapsed);
    this._maybeTriggerBurst(i, elapsed);
    const segMul = this._evalSegmentMultiplier(i, elapsed);
    const burst  = this._evalBurstMultiplier(i, elapsed);
    let m = segMul * (1 + burst);
    m = this.cfg.clamp(m, this.RHYTHM_CONF.bounds.min, this.RHYTHM_CONF.bounds.max);
    const w = this._rhythmWeightNow(elapsed);
    return this.cfg.lerp(1.0, m, w);
  }
}
