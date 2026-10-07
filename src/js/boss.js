/* boss.js — window.Boss extends Knight (extracted verbatim; known-broken in the original: see docs/FIX_PLAN.md 1.5) */
(() => {

    // Boss enemy class
    class Boss extends window.Knight {
        constructor() {
            super();
            this.mesh = window.Assets.get('knight');
            this.mesh.scale.set(2.2, 2.2, 2.2);
            this.mesh.userData = { hp: 400, type: 'boss' };
            
            // No helmet
            // Shield
            const shield = window.Assets.get('knight_boss_shield');
            shield.scale.set(1.2, 1.2, 1.2);
            shield.position.set(-1.5, 0.7, 0);
            shield.rotation.z = Math.PI / 2;
            this.mesh.add(shield);
            this.shield = shield;
            // Sword
            const sword = window.Assets.get('greatsword');
            sword.scale.set(1.5, 1.5, 1.5);
            sword.position.set(1.5, -0.2, 0);
            sword.rotation.z = -Math.PI / 2;
            this.mesh.add(sword);
            this.sword = sword;
            
            this.phase = 1;
            this.phaseTimer = 0;
            this.minionCount = 0;
        }
        
        update(dt, playerPos, waveNumber) {
            this.swingCooldown -= dt;
            this.phaseTimer += dt;
            
            // Adjust speed based on phase
            let speed = 2.2;
            if (this.phase >= 2) speed = 3.2;
            if (this.phase >= 3) speed = 4.0;
            
            // Update phase when hp < threshold
            if (this.phase === 1 && this.mesh.userData.hp < 267) {
                this.phase = 2;
                this.minionCount = 0;
                window.Sfx.bossRoar();
            } else if (this.phase === 2 && this.mesh.userData.hp < 134) {
                this.phase = 3;
                this.minionCount = 0;
                window.Sfx.bossRoar();
            }
            
            const dist = this.mesh.position.distanceTo(playerPos);
            if (dist < 6.0) {
                this.isAttacking = true;
                this.attackTime += dt;
                
                if (this.attackTime > 1.0) {
                    this.state = 'telegraph';
                }
                if (this.attackTime > 1.4) {
                    this.swingBig();
                    this.attackTime = 0;
                    this.state = 'walking';
                }
            } else {
                this.isAttacking = false;
                this.state = 'walking';
                this.attackTime = 0;
            }
            
            const moveDir = this.lookAt.clone().multiplyScalar(speed * dt);
            this.mesh.position.add(moveDir);
            
            // Animate shield/sword
            if (this.state === 'telegraph') {
                this.shield.rotation.x = 1.5;
                this.sword.rotation.x = -0.5;
            } else if (this.state === 'walking') {
                this.shield.rotation.x = 0.7;
                this.sword.rotation.x = 0.3;
            }
            
            // Spawn minions
            if (this.minionCount < this.phase) {
                const minion = new window.Knight();
                minion.mesh.position.copy(this.mesh.position);
                minion.mesh.position.x += Math.random() * 4 - 2;
                window.Enemies.add(minion);
                this.minionCount++;
            }
        }
        
        swingBig() {
            window.Sfx.swing();
            const angle = this.mesh.rotation.y;
            const halfArc = Math.PI * 110 / 180;
            const from = this.mesh.position.clone();
            const to = new THREE.Vector3(
                from.x + Math.sin(angle) * 6.0,
                from.y,
                from.z + Math.cos(angle) * 6.0
            );
            
            const raycaster = new THREE.Raycaster(from, to.clone().sub(from).normalize());
            const intersects = raycaster.intersectObjects(window.Enemies.rayTargets());
            for (const hit of intersects) {
                if (hit.object.userData.hp !== undefined) {
                    window.Player.hurt(15, hit.face.normal);
                }
            }
        }
        
        hurt(damage) {
            this.mesh.userData.hp -= damage;
            if (this.mesh.userData.hp <= 0) {
                this.die();
            }
        }
        
        die() {
            this.mesh.rotation.x = Math.PI / 2;
            this.mesh.rotation.z = Math.PI / 4;
            this.mesh.userData.dying = true;
            this.mesh.userData.fade = 1.0;
            this.mesh.userData.fadeSpeed = 0.02;
        }
    }

    window.Boss = Boss;
})();
