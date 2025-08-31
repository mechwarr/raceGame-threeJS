// racegame.js
// 封裝：提供靜態 API 以符合需求
//   建立：await RaceGame.Create({...});
//   取得：const game = RaceGame.GetGame();
//   操作：game.StartGame(); game.PauseGame(); game.DisposeGame();

;(function(global){
  /** @type {IframeGame|null} */
  let currentGame = null;

  class RaceGameAPI {
    /**
     * 建立遊戲（若已有舊 instance 會先釋放）
     * @param {ConstructorParameters<IframeGame>[0]} options
     * @returns {Promise<void>}
     */
    static async Create(options){
      if (currentGame){
        try{ currentGame.DisposeGame(); }catch(_){}
        currentGame = null;
      }
      currentGame = new global.IframeGame(options);
      await currentGame.Create();
    }

    /** 取得目前遊戲 instance（可為 null） */
    static GetGame(){
      return currentGame;
    }
  }

  // 全域暴露 API：RaceGame
  global.RaceGame = RaceGameAPI;

})(window);
