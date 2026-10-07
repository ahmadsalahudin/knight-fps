/* enemies.js — window.Knight, window.Enemies (extracted verbatim from the single-file build)
   Boss lives in boss.js, wave flow in waves.js. */
function cosTest(facing, toPlayer) { const n = toPlayer.clone().normalize(); return facing.x*n.x + facing.y*n.y + facing.z*n.z; }
(() => {

    // Knight enemy class
    class Knight {
        constructor() {
            this.mesh = window.Assets.get('knight');
            this.mesh.userData = { hp: 40, type: 'knight' };
            const _bb = new THREE.Box3().setFromObject(this.mesh);
            this._top = _bb.max.y; this._mid = (_bb.max.y + _bb.min.y) / 2;
          
            // Helmet
            const helmet = window.Assets.get('knight_helmet1');
            helmet.scale.set(0.9, 0.9, 0.9);
            helmet.position.set(0, this._top * 0.92, 0);
            this.mesh.add(helmet);
            this.helmet = helmet;
            
            // Shield
            const shield = window.Assets.get('knight_shield');
            shield.scale.set(0.8, 0.8, 0.8);
            shield.position.set(-this._top * 0.32, this._mid, 0);
            shield.rotation.z = Math.PI / 2;
            this.mesh.add(shield);
            this.shield = shield;
            
            // Sword
            const sword = window.Assets.get('knight_sword');
            sword.scale.set(0.8, 0.8, 0.8);
            sword.position.set(this._top * 0.32, this._mid, 0);
            sword.rotation.z = -Math.PI / 2;
            this.mesh.add(sword);
            this.sword = sword;
            
            // Movement and state
            this.speed = 2.2;
            this.isAttacking = false;
            this.isStrafing = false;
            this.strafeTime = 0;
            this.attackTime = 0;
            this.swingCooldown = 0;
            this.state = 'walking';
            this.lastStrafe = 0;
            this.lookAt = new THREE.Vector3();
            this.shieldUp = true;
            this.hasSwung = false;
            this._phase0 = Math.random() * 6.28;
        }
        
        update(dt, playerPos, waveNumber) {
            this.swingCooldown -= dt;
            const speed = waveNumber % 2 === 0 ? 3.4 : 2.2;
            this.attackTime += dt;
            
            if (this.isAttacking) {
                if (this.attackTime > 0.8) {
                    this.state = 'attack';
                }
                if (this.attackTime > 1.6) {
                    this.isAttacking = false;
                    this.attackTime = 0;
                    this.state = 'walking';
                    this.shieldUp = true;
                    this.hasSwung = false;
            this._phase0 = Math.random() * 6.28;
                }
            } else {
                // Strafing logic
                if (this.lastStrafe < 2 || this.lastStrafe > 4) {
                    this.isStrafing = true;
                    this.strafeTime += dt;
                    if (this.strafeTime > 1) {
                        this.isStrafing = false;
                        this.strafeTime = 0;
                        this.lastStrafe = 0;
                    }
                } else {
                    this.lastStrafe += dt;
                }
                
                const dist = this.mesh.position.distanceTo(playerPos);
                if (dist < 2.4) {
                    this.isAttacking = true;
                    this.attackTime = 0;
                    this.hasSwung = false;
                    this.state = 'telegraph';
                } else {
                    this.state = 'walking';
                }
            }
            
            // Look at the player
            this.lookAt.copy(playerPos).sub(this.mesh.position).normalize();
            this.mesh.lookAt(playerPos);
            
            // Movement — keep melee separation
            const gap = this.mesh.position.distanceTo(playerPos);
            if (gap > 1.4) {
                const moveDir = this.lookAt.clone().multiplyScalar(Math.min(speed * dt, gap - 1.4));
                this.mesh.position.add(moveDir);
            }
            
            // procedural march: bob
            const _t = performance.now() / 1000;
            this.mesh.position.y = Math.abs(Math.sin(_t * 6 + (this._phase0 || 0))) * 0.05;
            // Shield animation
            if (this.state === 'walking' || this.isStrafing) {
                this.shield.rotation.x = 0.7;
                this.sword.rotation.x = 0.3;
            } else if (this.state === 'telegraph') {
                this.shield.rotation.x = 1.5;
                this.sword.rotation.x = 1.0;
            } else if (this.state === 'attack') {
                this.shield.rotation.x = 1.5;
                this.sword.rotation.x = -0.8;
            }
            
            // Striking logic
            if (this.state === 'attack' && this.attackTime > 1.2 && !this.hasSwung) {
                this.hasSwung = true;
                this.swing();
            }
        }
        
        swing() {
            window.Sfx.swing();
            const playerPos = window.Game.playerObj.position;
            const from = new THREE.Vector3(this.mesh.position.x, this._mid, this.mesh.position.z);
            const toPlayer = playerPos.clone().sub(from);
            const dist = toPlayer.length();
            if (dist < 3.2 && cosTest(this.lookAt, toPlayer) > 0.2) {
                window.Player.hurt(15);
            }
        }
        
        hurt(damage) {
            this.mesh.userData.hp -= damage;
            if (this.mesh.userData.hp <= 0) {
                this.die();
            }
        }
        
        die() {
            // Ragdoll lite effect
            this.mesh.rotation.x = Math.PI / 2;
            this.mesh.rotation.z = Math.PI / 4;
            this.mesh.userData.dying = true;
            this.mesh.userData.fade = 1.0;
            this.mesh.userData.fadeSpeed = 0.02;
        }
    }

    window.Knight = Knight;

    // Enemies manager
    window.Enemies = {
        list: [],
        add(knight) {
            // ROOT CAUSE FIX: a knight JS object existing in the list is NOT enough —
            // the renderer only draws mesh objects actually parented to the scene graph.
            // Before this fix the list filled up forever (all raycasts, bboxes, HP reads
            // worked) but the renderer NEVER painted a single pixel of any knight, because
            // no one ever called scene.add(knight.mesh). Use window.Game.scene which
            // init() stored — no need to thread 'scene' through this closure.
            window.Game.scene.add(knight.mesh);
            this.list.push(knight);
        },
        update(dt, playerPos) {
            for (let i = this.list.length - 1; i >= 0; i--) {
                const enemy = this.list[i];
                if (enemy.mesh.userData.dying) {
                    enemy.mesh.userData.fade -= enemy.mesh.userData.fadeSpeed;
                    if (enemy.mesh.userData.fade <= 0) {
                        this.list.splice(i, 1);
                    }
                } else {
                    enemy.update(dt, playerPos, window.Waves.current);
                }
            }
        },
        rayTargets() {
            return this.list.map(e => e.mesh).filter(m => !m.userData.dying);
        },
        hurt(obj, damage) {
            if (obj.userData.hp !== undefined) {
                obj.userData.hp -= damage;
                if (obj.userData.hp <= 0) {
                    const enemy = this.list.find(e => e.mesh === obj);
                    if (enemy && !enemy.mesh.userData.dying) enemy.die();
                }
                if (this.list.every(e => e.mesh.userData.dying) && window.Waves && window.Waves.complete) {
                    window.Waves.complete();
                }
            }
        }
    };

})();
