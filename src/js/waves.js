/* waves.js — window.Waves (extracted verbatim; known-broken in the original: see docs/FIX_PLAN.md 1.5) */
(() => {

    // Wave system
    window.Waves = {
        current: 0,
        active: false,
        startTime: 0,
        knightCount: 0,
        respawnPending: 0,
        phase: 1,
        complete() {
            this.current++;
            if (window.HUD && HUD.setWave) HUD.setWave(this.current, Number(localStorage.getItem('kf_best') || 0));
            this.active = false;
            if (this.current >= 5) {
                if (window.HUD && HUD.victory) { HUD.victory(); document.exitPointerLock(); }
                return;
            }
            const self = this;
            setTimeout(function () { self.start(self.current); }, 4000);
        },
        start(waveNumber) {
            this.current = waveNumber;
            this.active = true;
            this.startTime = performance.now();
            this.knightCount = 3 + 2 * waveNumber;
            this.respawnPending = this.knightCount;
            if (window.HUD && HUD.setWave) window.HUD.setWave(waveNumber, Number(localStorage.getItem('kf_best') || 0));
            this.spawn();
        },
        spawn() {
            if (this.respawnPending <= 0 || !this.active) return;
            
            const edge = Math.random() * Math.PI * 2;
            const dist = 20;
            const x = Math.sin(edge) * dist;
            const z = Math.cos(edge) * dist;
            const boss = this.current === 5;
            
            const knight = boss ? new window.Boss() : new window.Knight();
            knight.mesh.position.set(x, 0, z);
            window.Enemies.add(knight);
            this.respawnPending--;
            
            if (this.respawnPending > 0) {
                setTimeout(() => this.spawn(), 300);
            }
        },
        update(dt) {
            if (!this.active) return;
            
            if (this.respawnPending > 0) {
                // Trigger before next respawn
                const now = performance.now();
                if (now - this.startTime > 2000) {
                    this.startTime = now;
                    this.spawn();
                }
            }
        }
    };

})();
