/* hud.js — window.HUD (extracted verbatim) + window.Smite (dead code in the original; lived in the same IIFE as HUD/Sfx).
   The original called HUD.init() at script time; main.js now calls it once during boot. */
(function() {
  // window.HUD implementation
  const HUD = {
    init: function() {
      let crosshair = document.getElementById('crosshair');
      if (!crosshair) {
        crosshair = document.createElement('div');
        crosshair.id = 'crosshair';
        crosshair.style.position = 'fixed';
        crosshair.style.left = '50%';
        crosshair.style.top = '50%';
        crosshair.style.transform = 'translate(-50%, -50%)';
        crosshair.style.width = '20px';
        crosshair.style.height = '20px';
        crosshair.style.pointerEvents = 'none';
        crosshair.style.zIndex = '1000';
        crosshair.innerHTML = `
          <div style="position:absolute; width:2px; height:20px; left:9px; top:0; background:#fff"></div>
          <div style="position:absolute; width:20px; height:2px; left:0; top:9px; background:#fff"></div>
          <div style="position:absolute; width:4px; height:4px; left:8px; top:8px; background:#fff; border-radius:50%"></div>
        `;
        document.body.appendChild(crosshair);
      }

      let healthFill = document.getElementById('hpFill');
      if (!healthFill) {
        healthFill = document.createElement('div');
        healthFill.id = 'healthFill';
        healthFill.style.width = '100%';
        healthFill.style.height = '100%';
        healthFill.style.background = '#f00';
        healthFill.style.transition = 'width 0.3s';
        const healthBar = document.createElement('div');
        healthBar.id = 'healthBar';
        healthBar.style.position = 'fixed';
        healthBar.style.left = '20px';
        healthBar.style.bottom = '20px';
        healthBar.style.width = '200px';
        healthBar.style.height = '20px';
        healthBar.style.background = '#333';
        healthBar.style.border = '1px solid #fff';
        healthBar.style.borderRadius = '4px';
        healthBar.style.overflow = 'hidden';
        healthBar.style.zIndex = '1000';
        healthBar.appendChild(healthFill);
        document.body.appendChild(healthBar);
      }

      const existingPips = document.querySelectorAll('.ammo-pip');
      if (existingPips.length < 6) {
        const ammoContainer = document.createElement('div');
        ammoContainer.id = 'ammoContainer';
        ammoContainer.style.position = 'fixed';
        ammoContainer.style.right = '20px';
        ammoContainer.style.bottom = '20px';
        ammoContainer.style.display = 'flex';
        ammoContainer.style.gap = '4px';
        ammoContainer.style.zIndex = '1000';

        const neededPips = 6 - existingPips.length;
        for (let i = 0; i < neededPips; i++) {
          const pip = document.createElement('div');
          pip.className = 'ammo-pip';
          pip.style.width = '16px';
          pip.style.height = '16px';
          pip.style.background = '#444';
          pip.style.border = '1px solid #fff';
          pip.style.borderRadius = '50%';
          ammoContainer.appendChild(pip);
        }
        document.body.appendChild(ammoContainer);
      }

      let spinner = document.getElementById('reloadSpinner');
      if (!spinner) {
        spinner = document.createElement('div');
        spinner.id = 'reloadSpinner';
        spinner.style.position = 'fixed';
        spinner.style.right = '20px';
        spinner.style.bottom = '44px';
        spinner.style.width = '16px';
        spinner.style.height = '16px';
        spinner.style.border = '2px solid transparent';
        spinner.style.borderTopColor = '#0f0';
        spinner.style.borderRadius = '50%';
        spinner.style.animation = 'spin 0.5s linear infinite';
        spinner.style.display = 'none';
        spinner.style.zIndex = '1000';
        document.body.appendChild(spinner);

        // CSS for spinner animation
        const style = document.createElement('style');
        style.textContent = `
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `;
        document.head.appendChild(style);
      }

      let waveInfo = document.getElementById('waveInfo');
      if (!waveInfo) {
        waveInfo = document.createElement('div');
        waveInfo.id = 'waveInfo';
        waveInfo.style.position = 'fixed';
        waveInfo.style.left = '50%';
        waveInfo.style.top = '20px';
        waveInfo.style.transform = 'translateX(-50%)';
        waveInfo.style.color = '#fff';
        waveInfo.style.fontFamily = 'monospace';
        waveInfo.style.fontSize = '16px';
        waveInfo.style.textAlign = 'center';
        waveInfo.style.zIndex = '1000';
        document.body.appendChild(waveInfo);
      }

      let vignette = document.getElementById('vignette');
      if (!vignette) {
        vignette = document.createElement('div');
        vignette.id = 'vignette';
        vignette.style.position = 'fixed';
        vignette.style.width = '100%';
        vignette.style.height = '100%';
        vignette.style.background = 'rgba(255, 0, 0, 0.3)';
        vignette.style.pointerEvents = 'none';
        vignette.style.display = 'none';
        vignette.style.zIndex = '999';
        document.body.appendChild(vignette);
      }

      let hitMarker = document.getElementById('hitMarker');
      if (!hitMarker) {
        hitMarker = document.createElement('div');
        hitMarker.id = 'hitMarker';
        hitMarker.style.position = 'fixed';
        hitMarker.style.left = '50%';
        hitMarker.style.top = '50%';
        hitMarker.style.width = '20px';
        hitMarker.style.height = '20px';
        hitMarker.style.pointerEvents = 'none';
        hitMarker.style.display = 'none';
        hitMarker.style.zIndex = '1000';
        hitMarker.innerHTML = `
          <div style="position:absolute; width:2px; height:20px; left:9px; top:0; background:#ff0"></div>
          <div style="position:absolute; width:20px; height:2px; left:0; top:9px; background:#ff0"></div>
        `;
        document.body.appendChild(hitMarker);
      }

      let gameOverScreen = document.getElementById('gameOverScreen');
      if (!gameOverScreen) {
        gameOverScreen = document.createElement('div');
        gameOverScreen.id = 'gameOverScreen';
        gameOverScreen.style.position = 'fixed';
        gameOverScreen.style.width = '100%';
        gameOverScreen.style.height = '100%';
        gameOverScreen.style.background = 'rgba(0,0,0,0.8)';
        gameOverScreen.style.display = 'none';
        gameOverScreen.style.flexDirection = 'column';
        gameOverScreen.style.justifyContent = 'center';
        gameOverScreen.style.alignItems = 'center';
        gameOverScreen.style.color = '#fff';
        gameOverScreen.style.fontFamily = 'monospace';
        gameOverScreen.style.zIndex = '2000';
        gameOverScreen.innerHTML = `
          <div style="font-size:24px; margin-bottom:20px;">GAME OVER</div>
          <div id="gameOverWave" style="font-size:18px; margin-bottom:20px;"></div>
          <div id="gameOverBest" style="font-size:14px; margin-bottom:40px;"></div>
          <button id="restartButton" style="padding:10px 20px; background:#444; color:#fff; border:none; font-family:monospace;">RESTART</button>
        `;

        document.body.appendChild(gameOverScreen);
      }

      let victoryScreen = document.getElementById('victoryScreen');
      if (!victoryScreen) {
        victoryScreen = document.createElement('div');
        victoryScreen.id = 'victoryScreen';
        victoryScreen.style.position = 'fixed';
        victoryScreen.style.width = '100%';
        victoryScreen.style.height = '100%';
        victoryScreen.style.background = 'rgba(0,0,0,0.8)';
        victoryScreen.style.display = 'none';
        victoryScreen.style.flexDirection = 'column';
        victoryScreen.style.justifyContent = 'center';
        victoryScreen.style.alignItems = 'center';
        victoryScreen.style.color = '#fff';
        victoryScreen.style.fontFamily = 'monospace';
        victoryScreen.style.zIndex = '2000';
        victoryScreen.innerHTML = `
          <div style="font-size:24px; margin-bottom:20px;">VICTORY</div>
          <div id="victoryWave" style="font-size:18px; margin-bottom:20px;"></div>
          <div id="victoryBest" style="font-size:14px; margin-bottom:40px;"></div>
          <button id="continueButton" style="padding:10px 20px; background:#444; color:#fff; border:none; font-family:monospace;">CONTINUE</button>
        `;

        document.body.appendChild(victoryScreen);
      }

      // Add restart onclick handlers
      document.getElementById('restartButton').addEventListener('click', () => {
        window.location.reload();
      });

      document.getElementById('continueButton').addEventListener('click', () => {
        window.location.reload();
      });
    },

    setWave: function(wave, best) {
      document.getElementById('waveInfo').textContent = `WAVE ${wave} | BEST ${best}`;
    },

    updateAmmo: function(ammo, maxAmmo, reloading) {
      const pips = document.querySelectorAll('.ammo-pip');
      for (let i = 0; i < pips.length; i++) {
        pips[i].style.background = i < ammo ? '#0f0' : '#444';
        if (i >= maxAmmo && ammo === maxAmmo) {
          pips[i].style.background = '#0f0';
        }
      }

      const spinner = document.getElementById('reloadSpinner');
      if (reloading) {
        spinner.style.display = 'block';
      } else {
        spinner.style.display = 'none';
      }
    },

    playerHit: function() {
      const vignette = document.getElementById('vignette');
      vignette.style.display = 'block';
      setTimeout(() => {
        vignette.style.display = 'none';
      }, 100);
    },

    hitmark: function() {
      const marker = document.getElementById('hitMarker');
      marker.style.display = 'block';
      setTimeout(() => {
        marker.style.display = 'none';
      }, 300);
    },

    gameOver: function(wave) {
      const best = parseInt(localStorage.getItem('kf_best') || '0');
      const gameOverScreen = document.getElementById('gameOverScreen');
      document.getElementById('gameOverWave').textContent = `WAVE REACHED: ${wave}`;
      document.getElementById('gameOverBest').textContent = `BEST: ${best}`;
      gameOverScreen.style.display = 'flex';
    },

    victory: function(wave) {
      const best = parseInt(localStorage.getItem('kf_best') || '0');
      const victoryScreen = document.getElementById('victoryScreen');
      document.getElementById('victoryWave').textContent = `WAVE COMPLETED: ${wave}`;
      document.getElementById('victoryBest').textContent = `BEST: ${best}`;
      victoryScreen.style.display = 'flex';
    },

    updateHP: function(health) {
      const a = document.getElementById('hpFill') || document.getElementById('healthFill');
      if (a) a.style.width = `${Math.max(0, health)}%`;
    }
  };

  // window.Smite implementation
  const Smite = {
    _active: false,
    _timer: 0,
    _glow: null,

    // Arms current shot with holy smite enhancer
    arm: function(shot) {
      if (this._active) {
        shot.holySmite = true;
      }
    },

    // Applies smite effect to ray hit
    maybeApply: function(rayHit) {
      if (this._active && rayHit && rayHit.point) {
        // Step 1: Fire a ray from player's position toward hit point
        const direction = rayHit.point.clone().sub(window.Player.position).normalize();
        const origin = window.Player.position.clone();
        
        // For simplicity in this single module context, we'll just implement the sound and visual feedback
        // Real implementation would involve actual ray tracing against the scene
        
        window.Sfx.roar(); // Visual and audio feedback
        
        // Mark the effect as applied (in this context just visual)
        return true;
      }
      return false;
    },

    // Update smite state
    update: function(dt, playerPos) {
      if (this._active) {
        this._timer -= dt;
        if (this._timer <= 0) {
          this._active = false;
          if (this._glow) this._glow.style.display = 'none';
        }
      }
    },

    // Starts new smite effect
    activate: function() {
      if (!this._active) {
        this._active = true;
        this._timer = 6.0; // 6 seconds
        if (!this._glow) {
          this._glow = document.createElement('div');
          this._glow.id = 'smiteGlow';
          this._glow.style.position = 'fixed';
          this._glow.style.width = '64px';
          this._glow.style.height = '64px';
          this._glow.style.borderRadius = '50%';
          this._glow.style.background = 'radial-gradient(circle, rgba(255,255,0,0.5) 0%, rgba(255,255,0,0) 70%)';
          this._glow.style.left = '0';
          this._glow.style.top = '0';
          this._glow.style.pointerEvents = 'none';
          this._glow.style.zIndex = '1000';
          this._glow.style.display = 'none';
          document.body.appendChild(this._glow);
        }
        this._glow.style.display = 'block';
      }
    }
  };

  window.HUD = HUD;
  window.Smite = Smite;
})();
