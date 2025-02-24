
import * as THREE from 'three';

let SUPPORT_TRANSFERABLE,
    _is_simulating = false,
    _Physijs = window.Physijs; // used for noConflict method

let _temp1, _temp2,
    _temp_vector3_1 = new THREE.Vector3(),
    _temp_vector3_2 = new THREE.Vector3(),
    _temp_matrix4_1 = new THREE.Matrix4(),
    _quaternion_1 = new THREE.Quaternion();

// constants
const MESSAGE_TYPES = {
    WORLDREPORT: 0,
    COLLISIONREPORT: 1,
    VEHICLEREPORT: 2,
    CONSTRAINTREPORT: 3
}
const REPORT_ITEMSIZE = 14;
const COLLISIONREPORT_ITEMSIZE = 5;
const VEHICLEREPORT_ITEMSIZE = 9;
const CONSTRAINTREPORT_ITEMSIZE = 6;

function Eventable() {
    this._eventListeners = {};
};
Object.assign( Eventable.prototype, {
    addEventListener: function ( event_name, callback ) {
        if ( !this._eventListeners.hasOwnProperty( event_name ) ) {
            this._eventListeners[ event_name ] = [];
        }
        this._eventListeners[ event_name ].push( callback );
    },
    removeEventListener: function ( event_name, callback ) {
        let index;

        if ( !this._eventListeners.hasOwnProperty( event_name ) ) return false;

        if ( ( index = this._eventListeners[ event_name ].indexOf( callback ) ) >= 0 ) {
            this._eventListeners[ event_name ].splice( index, 1 );
            return true;
        }

        return false;
    },
    dispatchEvent: function ( event_name ) {
        let i,
            parameters = Array.prototype.splice.call( arguments, 1 );

        if ( this._eventListeners.hasOwnProperty( event_name ) ) {
            for ( i = 0; i < this._eventListeners[ event_name ].length; i++ ) {
                this._eventListeners[ event_name ][ i ].apply( this, parameters );
            }
        }
    }
} );
Eventable.make = function ( obj ) {
    obj.prototype.addEventListener = Eventable.prototype.addEventListener;
    obj.prototype.removeEventListener = Eventable.prototype.removeEventListener;
    obj.prototype.dispatchEvent = Eventable.prototype.dispatchEvent;
};

let getObjectId = ( function () {
    let _id = 1;
    return function () {
        return _id++;
    };
} )();

function getEulerXYZFromQuaternion( x, y, z, w ) {
    return new THREE.Vector3(
        Math.atan2( 2 * ( x * w - y * z ), ( w * w - x * x - y * y + z * z ) ),
        Math.asin( 2 * ( x * z + y * w ) ),
        Math.atan2( 2 * ( z * w - x * y ), ( w * w + x * x - y * y - z * z ) )
    );
};

function getQuatertionFromEuler( x, y, z ) {
    let c1, s1, c2, s2, c3, s3, c1c2, s1s2;
    c1 = Math.cos( y );
    s1 = Math.sin( y );
    c2 = Math.cos( -z );
    s2 = Math.sin( -z );
    c3 = Math.cos( x );
    s3 = Math.sin( x );

    c1c2 = c1 * c2;
    s1s2 = s1 * s2;

    return {
        w: c1c2 * c3 - s1s2 * s3,
        x: c1c2 * s3 + s1s2 * c3,
        y: s1 * c2 * c3 + c1 * s2 * s3,
        z: c1 * s2 * c3 - s1 * c2 * s3
    };
};

function convertWorldPositionToObject( position, object ) {
    _temp_matrix4_1.identity(); // reset temp matrix

    // Set the temp matrix's rotation to the object's rotation
    _temp_matrix4_1.identity().makeRotationFromQuaternion( object.quaternion );

    // Invert rotation matrix in order to "unrotate" a point back to object space
    _temp_matrix4_1.invert();

    // Yay! Temp lets!
    _temp_vector3_1.copy( position );
    _temp_vector3_2.copy( object.position );

    // Apply the rotation

    return _temp_vector3_1.sub( _temp_vector3_2 ).applyMatrix4( _temp_matrix4_1 );
};

// Physijs.noConflict
function noConflict() {
    window.Physijs = _Physijs;
    return Physijs;
};

// Physijs.createMaterial
function createMaterial( material, friction, restitution ) {
    let physijs_material = function () { };
    physijs_material.prototype = material;
    physijs_material = new physijs_material;

    physijs_material._physijs = {
        id: material.id,
        friction: friction ?? .8,
        restitution: restitution ?? .2
    };

    return physijs_material;
};

class PointConstraint {

    constructor( objecta, objectb, position ) {
        if ( position === undefined ) {
            position = objectb;
            objectb = undefined;
        }

        this.type = 'point';
        this.appliedImpulse = 0;
        this.id = getObjectId();
        this.objecta = objecta._physijs.id;
        this.positiona = convertWorldPositionToObject( position, objecta ).clone();

        if ( objectb ) {
            this.objectb = objectb._physijs.id;
            this.positionb = convertWorldPositionToObject( position, objectb ).clone();
        }
    }

    getDefinition() {
        return {
            type: this.type,
            id: this.id,
            objecta: this.objecta,
            objectb: this.objectb,
            positiona: this.positiona,
            positionb: this.positionb
        };
    }

}

class HingeConstraint {
    constructor( objecta, objectb, position, axis ) {
        if ( axis === undefined ) {
            axis = position;
            position = objectb;
            objectb = undefined;
        }

        this.type = 'hinge';
        this.appliedImpulse = 0;
        this.id = getObjectId();
        this.scene = objecta.parent;
        this.objecta = objecta._physijs.id;
        this.positiona = convertWorldPositionToObject( position, objecta ).clone();
        this.position = position.clone();
        this.axis = axis;

        if ( objectb ) {
            this.objectb = objectb._physijs.id;
            this.positionb = convertWorldPositionToObject( position, objectb ).clone();
        }
    }
    getDefinition() {
        return {
            type: this.type,
            id: this.id,
            objecta: this.objecta,
            objectb: this.objectb,
            positiona: this.positiona,
            positionb: this.positionb,
            axis: this.axis
        };
    }
    /*
     * low = minimum angle in radians
     * high = maximum angle in radians
     * bias_factor = applied as a factor to constraint error
     * relaxation_factor = controls bounce (0.0 == no bounce)
     */
    setLimits( low, high, bias_factor, relaxation_factor ) {
        this.scene.execute( 'hinge_setLimits', { constraint: this.id, low: low, high: high, bias_factor: bias_factor, relaxation_factor: relaxation_factor } );
    }
    enableAngularMotor( velocity, acceleration ) {
        this.scene.execute( 'hinge_enableAngularMotor', { constraint: this.id, velocity: velocity, acceleration: acceleration } );
    }
    disableMotor( velocity, acceleration ) {
        this.scene.execute( 'hinge_disableMotor', { constraint: this.id } );
    }
}

class SliderConstraint {
    constructor( objecta, objectb, position, axis ) {
        if ( axis === undefined ) {
            axis = position;
            position = objectb;
            objectb = undefined;
        }

        this.type = 'slider';
        this.appliedImpulse = 0;
        this.id = getObjectId();
        this.scene = objecta.parent;
        this.objecta = objecta._physijs.id;
        this.positiona = convertWorldPositionToObject( position, objecta ).clone();
        this.axis = axis;

        if ( objectb ) {
            this.objectb = objectb._physijs.id;
            this.positionb = convertWorldPositionToObject( position, objectb ).clone();
        }
    }
    getDefinition() {
        return {
            type: this.type,
            id: this.id,
            objecta: this.objecta,
            objectb: this.objectb,
            positiona: this.positiona,
            positionb: this.positionb,
            axis: this.axis
        };
    }
    setLimits( lin_lower, lin_upper, ang_lower, ang_upper ) {
        this.scene.execute( 'slider_setLimits', { constraint: this.id, lin_lower: lin_lower, lin_upper: lin_upper, ang_lower: ang_lower, ang_upper: ang_upper } );
    }
    setRestitution( linear, angular ) {
        this.scene.execute(
            'slider_setRestitution',
            {
                constraint: this.id,
                linear: linear,
                angular: angular
            }
        );
    }
    enableLinearMotor( velocity, acceleration ) {
        this.scene.execute( 'slider_enableLinearMotor', { constraint: this.id, velocity: velocity, acceleration: acceleration } );
    }
    disableLinearMotor() {
        this.scene.execute( 'slider_disableLinearMotor', { constraint: this.id } );
    }
    enableAngularMotor( velocity, acceleration ) {
        this.scene.execute( 'slider_enableAngularMotor', { constraint: this.id, velocity: velocity, acceleration: acceleration } );
    }
    disableAngularMotor() {
        this.scene.execute( 'slider_disableAngularMotor', { constraint: this.id } );
    }
}

class ConeTwistConstraint {
    constructor( objecta, objectb, position ) {
        if ( position === undefined ) {
            throw 'Both objects must be defined in a ConeTwistConstraint.';
        }
        this.type = 'conetwist';
        this.appliedImpulse = 0;
        this.id = getObjectId();
        this.scene = objecta.parent;
        this.objecta = objecta._physijs.id;
        this.positiona = convertWorldPositionToObject( position, objecta ).clone();
        this.objectb = objectb._physijs.id;
        this.positionb = convertWorldPositionToObject( position, objectb ).clone();
        this.axisa = { x: objecta.rotation.x, y: objecta.rotation.y, z: objecta.rotation.z };
        this.axisb = { x: objectb.rotation.x, y: objectb.rotation.y, z: objectb.rotation.z };
    }
    getDefinition() {
        return {
            type: this.type,
            id: this.id,
            objecta: this.objecta,
            objectb: this.objectb,
            positiona: this.positiona,
            positionb: this.positionb,
            axisa: this.axisa,
            axisb: this.axisb
        };
    }
    setLimit( x, y, z ) {
        this.scene.execute( 'conetwist_setLimit', { constraint: this.id, x: x, y: y, z: z } );
    }
    enableMotor() {
        this.scene.execute( 'conetwist_enableMotor', { constraint: this.id } );
    }
    setMaxMotorImpulse( max_impulse ) {
        this.scene.execute( 'conetwist_setMaxMotorImpulse', { constraint: this.id, max_impulse: max_impulse } );
    }
    setMotorTarget( target ) {
        if ( target instanceof THREE.Vector3 ) {
            target = new THREE.Quaternion().setFromEuler( new THREE.Euler( target.x, target.y, target.z ) );
        } else if ( target instanceof THREE.Euler ) {
            target = new THREE.Quaternion().setFromEuler( target );
        } else if ( target instanceof THREE.Matrix4 ) {
            target = new THREE.Quaternion().setFromRotationMatrix( target );
        }
        this.scene.execute( 'conetwist_setMotorTarget', { constraint: this.id, x: target.x, y: target.y, z: target.z, w: target.w } );
    }
    disableMotor() {
        this.scene.execute( 'conetwist_disableMotor', { constraint: this.id } );
    }
}

class DOFConstraint {
    constructor( objecta, objectb, position ) {
        if ( position === undefined ) {
            position = objectb;
            objectb = undefined;
        }
        this.type = 'dof';
        this.appliedImpulse = 0;
        this.id = getObjectId();
        this.scene = objecta.parent;
        this.objecta = objecta._physijs.id;
        this.positiona = convertWorldPositionToObject( position, objecta ).clone();
        this.axisa = { x: objecta.rotation.x, y: objecta.rotation.y, z: objecta.rotation.z };

        if ( objectb ) {
            this.objectb = objectb._physijs.id;
            this.positionb = convertWorldPositionToObject( position, objectb ).clone();
            this.axisb = { x: objectb.rotation.x, y: objectb.rotation.y, z: objectb.rotation.z };
        }
    }
    getDefinition() {
        return {
            type: this.type,
            id: this.id,
            objecta: this.objecta,
            objectb: this.objectb,
            positiona: this.positiona,
            positionb: this.positionb,
            axisa: this.axisa,
            axisb: this.axisb
        };
    }
    setLinearLowerLimit( limit ) {
        this.scene.execute( 'dof_setLinearLowerLimit', { constraint: this.id, x: limit.x, y: limit.y, z: limit.z } );
    }
    setLinearUpperLimit( limit ) {
        this.scene.execute( 'dof_setLinearUpperLimit', { constraint: this.id, x: limit.x, y: limit.y, z: limit.z } );
    }
    setAngularLowerLimit( limit ) {
        this.scene.execute( 'dof_setAngularLowerLimit', { constraint: this.id, x: limit.x, y: limit.y, z: limit.z } );
    }
    setAngularUpperLimit( limit ) {
        this.scene.execute( 'dof_setAngularUpperLimit', { constraint: this.id, x: limit.x, y: limit.y, z: limit.z } );
    }
    enableAngularMotor( which ) {
        this.scene.execute( 'dof_enableAngularMotor', { constraint: this.id, which: which } );
    }
    configureAngularMotor( which, low_angle, high_angle, velocity, max_force ) {
        this.scene.execute( 'dof_configureAngularMotor', { constraint: this.id, which: which, low_angle: low_angle, high_angle: high_angle, velocity: velocity, max_force: max_force } );
    }
    disableAngularMotor( which ) {
        this.scene.execute( 'dof_disableAngularMotor', { constraint: this.id, which: which } );
    }
}

// Physijs.Scene
class Scene extends THREE.Scene {
    constructor( params ) {

        super();

        Eventable.call( this );

        let self = this;

        this._worker = new Worker( Physijs.scripts.worker || 'physijs_worker.js' );
        this._worker.transferableMessage = this._worker.webkitPostMessage || this._worker.postMessage;
        this._materials_ref_counts = {};
        this._objects = {};
        this._vehicles = {};
        this._constraints = {};

        let ab = new ArrayBuffer( 1 );
        this._worker.transferableMessage( ab, [ ab ] );
        SUPPORT_TRANSFERABLE = ( ab.byteLength === 0 );

        this._worker.onmessage = function ( event ) {
            let _temp, data = event.data;

            if ( data instanceof ArrayBuffer && data.byteLength !== 1 ) { // byteLength === 1 is the worker making a SUPPORT_TRANSFERABLE test
                data = new Float32Array( data );
            }

            if ( data instanceof Float32Array ) {

                // transferable object
                switch ( data[ 0 ] ) {
                    case MESSAGE_TYPES.WORLDREPORT:
                        self._updateScene( data );
                        break;

                    case MESSAGE_TYPES.COLLISIONREPORT:
                        self._updateCollisions( data );
                        break;

                    case MESSAGE_TYPES.VEHICLEREPORT:
                        self._updateVehicles( data );
                        break;

                    case MESSAGE_TYPES.CONSTRAINTREPORT:
                        self._updateConstraints( data );
                        break;
                }

            } else {

                if ( data.cmd ) {

                    // non-transferable object
                    switch ( data.cmd ) {
                        case 'objectReady':
                            _temp = data.params;
                            if ( self._objects[ _temp ] ) {
                                self._objects[ _temp ].dispatchEvent( 'ready' );
                            }
                            break;

                        case 'worldReady':
                            self.dispatchEvent( 'ready' );
                            break;

                        case 'vehicle':
                            window.test = data;
                            break;

                        default:
                            // Do nothing, just show the message
                            console.debug( 'Received: ' + data.cmd );
                            console.dir( data.params );
                            break;
                    }

                } else {

                    switch ( data[ 0 ] ) {
                        case MESSAGE_TYPES.WORLDREPORT:
                            self._updateScene( data );
                            break;

                        case MESSAGE_TYPES.COLLISIONREPORT:
                            self._updateCollisions( data );
                            break;

                        case MESSAGE_TYPES.VEHICLEREPORT:
                            self._updateVehicles( data );
                            break;

                        case MESSAGE_TYPES.CONSTRAINTREPORT:
                            self._updateConstraints( data );
                            break;
                    }

                }

            }
        };


        params = params || {};
        params.ammo = Physijs.scripts.ammo || 'ammo.js';
        params.fixedTimeStep = params.fixedTimeStep || 1 / 60;
        params.rateLimit = params.rateLimit || true;
        this.execute( 'init', params );
    }
    _updateScene( data ) {
        let num_objects = data[ 1 ], object, i, offset;

        for ( i = 0; i < num_objects; i++ ) {
            offset = 2 + i * REPORT_ITEMSIZE;
            object = this._objects[ data[ offset ] ];

            if ( object === undefined ) {
                continue;
            }

            if ( object.__dirtyPosition === false ) {
                object.position.set(
                    data[ offset + 1 ],
                    data[ offset + 2 ],
                    data[ offset + 3 ]
                );
            }

            if ( object.__dirtyRotation === false ) {
                object.quaternion.set(
                    data[ offset + 4 ],
                    data[ offset + 5 ],
                    data[ offset + 6 ],
                    data[ offset + 7 ]
                );
            }

            object._physijs.linearVelocity.set(
                data[ offset + 8 ],
                data[ offset + 9 ],
                data[ offset + 10 ]
            );

            object._physijs.angularVelocity.set(
                data[ offset + 11 ],
                data[ offset + 12 ],
                data[ offset + 13 ]
            );

        }

        if ( SUPPORT_TRANSFERABLE ) {
            // Give the typed array back to the worker
            this._worker.transferableMessage( data.buffer, [ data.buffer ] );
        }

        _is_simulating = false;
        this.dispatchEvent( 'update' );
    }
    _updateVehicles( data ) {
        let vehicle, wheel, i, offset;

        for ( i = 0; i < ( data.length - 1 ) / VEHICLEREPORT_ITEMSIZE; i++ ) {
            offset = 1 + i * VEHICLEREPORT_ITEMSIZE;
            vehicle = this._vehicles[ data[ offset ] ];

            if ( vehicle === undefined ) {
                continue;
            }

            wheel = vehicle.wheels[ data[ offset + 1 ] ];

            wheel.position.set(
                data[ offset + 2 ],
                data[ offset + 3 ],
                data[ offset + 4 ]
            );

            wheel.quaternion.set(
                data[ offset + 5 ],
                data[ offset + 6 ],
                data[ offset + 7 ],
                data[ offset + 8 ]
            );
        }

        if ( SUPPORT_TRANSFERABLE ) {
            // Give the typed array back to the worker
            this._worker.transferableMessage( data.buffer, [ data.buffer ] );
        }
    }
    _updateConstraints( data ) {
        let constraint, object, i, offset;

        for ( i = 0; i < ( data.length - 1 ) / CONSTRAINTREPORT_ITEMSIZE; i++ ) {
            offset = 1 + i * CONSTRAINTREPORT_ITEMSIZE;
            constraint = this._constraints[ data[ offset ] ];
            object = this._objects[ data[ offset + 1 ] ];

            if ( constraint === undefined || object === undefined ) {
                continue;
            }

            _temp_vector3_1.set(
                data[ offset + 2 ],
                data[ offset + 3 ],
                data[ offset + 4 ]
            );
            _temp_matrix4_1.extractRotation( object.matrix );
            _temp_vector3_1.applyMatrix4( _temp_matrix4_1 );

            constraint.positiona.addVectors( object.position, _temp_vector3_1 );
            constraint.appliedImpulse = data[ offset + 5 ];
        }

        if ( SUPPORT_TRANSFERABLE ) {
            // Give the typed array back to the worker
            this._worker.transferableMessage( data.buffer, [ data.buffer ] );
        }
    }
    _updateCollisions( data ) {
        /**
         * #TODO
         * This is probably the worst way ever to handle collisions. The inherent evilness is a residual
         * effect from the previous version's evilness which mutated when switching to transferable objects.
         *
         * If you feel inclined to make this better, please do so.
         */
        let i, j, offset, object, object2, id1, id2, collisions = {}, normal_offsets = {};

        // Build collision manifest
        for ( i = 0; i < data[ 1 ]; i++ ) {
            offset = 2 + i * COLLISIONREPORT_ITEMSIZE;
            object = data[ offset ];
            object2 = data[ offset + 1 ];

            normal_offsets[ object + '-' + object2 ] = offset + 2;
            normal_offsets[ object2 + '-' + object ] = -1 * ( offset + 2 );

            // Register collisions for both the object colliding and the object being collided with
            if ( !collisions[ object ] )
                collisions[ object ] = [];
            collisions[ object ].push( object2 );

            if ( !collisions[ object2 ] )
                collisions[ object2 ] = [];
            collisions[ object2 ].push( object );
        }

        // Deal with collisions
        for ( id1 in this._objects ) {
            if ( !this._objects.hasOwnProperty( id1 ) )
                continue;
            object = this._objects[ id1 ];

            // If object touches anything, ...
            if ( collisions[ id1 ] ) {

                // Clean up touches array
                for ( j = 0; j < object._physijs.touches.length; j++ ) {
                    if ( collisions[ id1 ].indexOf( object._physijs.touches[ j ] ) === -1 ) {
                        object._physijs.touches.splice( j--, 1 );
                    }
                }

                // Handle each colliding object
                for ( j = 0; j < collisions[ id1 ].length; j++ ) {
                    id2 = collisions[ id1 ][ j ];
                    object2 = this._objects[ id2 ];

                    if ( object2 ) {
                        // If object was not already touching object2, notify object
                        if ( object._physijs.touches.indexOf( id2 ) === -1 ) {
                            object._physijs.touches.push( id2 );

                            _temp_vector3_1.subVectors( object.getLinearVelocity(), object2.getLinearVelocity() );
                            _temp1 = _temp_vector3_1.clone();

                            _temp_vector3_1.subVectors( object.getAngularVelocity(), object2.getAngularVelocity() );
                            _temp2 = _temp_vector3_1.clone();

                            let normal_offset = normal_offsets[ object._physijs.id + '-' + object2._physijs.id ];
                            if ( normal_offset > 0 ) {
                                _temp_vector3_1.set(
                                    -data[ normal_offset ],
                                    -data[ normal_offset + 1 ],
                                    -data[ normal_offset + 2 ]
                                );
                            } else {
                                normal_offset *= -1;
                                _temp_vector3_1.set(
                                    data[ normal_offset ],
                                    data[ normal_offset + 1 ],
                                    data[ normal_offset + 2 ]
                                );
                            }

                            object.dispatchEvent( 'collision', object2, _temp1, _temp2, _temp_vector3_1 );
                        }
                    }
                }

            } else {

                // not touching other objects
                object._physijs.touches.length = 0;

            }

        }

        this.collisions = collisions;

        if ( SUPPORT_TRANSFERABLE ) {
            // Give the typed array back to the worker
            this._worker.transferableMessage( data.buffer, [ data.buffer ] );
        }
    }
    addConstraint( constraint, show_marker ) {
        this._constraints[ constraint.id ] = constraint;
        this.execute( 'addConstraint', constraint.getDefinition() );

        if ( show_marker ) {
            let marker;

            switch ( constraint.type ) {
                case 'point':
                    marker = new THREE.Mesh(
                        new THREE.SphereGeometry( 1.5 ),
                        new THREE.MeshNormalMaterial
                    );
                    marker.position.copy( constraint.positiona );
                    this._objects[ constraint.objecta ].add( marker );
                    break;

                case 'hinge':
                    marker = new THREE.Mesh(
                        new THREE.SphereGeometry( 1.5 ),
                        new THREE.MeshNormalMaterial
                    );
                    marker.position.copy( constraint.positiona );
                    this._objects[ constraint.objecta ].add( marker );
                    break;

                case 'slider':
                    marker = new THREE.Mesh(
                        new THREE.BoxGeometry( 10, 1, 1 ),
                        new THREE.MeshNormalMaterial
                    );
                    marker.position.copy( constraint.positiona );
                    // This rotation isn't right if all three axis are non-0 values
                    // TODO: change marker's rotation order to ZYX
                    marker.rotation.set(
                        constraint.axis.y,
                        constraint.axis.x,
                        constraint.axis.z
                    );
                    this._objects[ constraint.objecta ].add( marker );
                    break;

                case 'conetwist':
                    marker = new THREE.Mesh(
                        new THREE.SphereGeometry( 1.5 ),
                        new THREE.MeshNormalMaterial
                    );
                    marker.position.copy( constraint.positiona );
                    this._objects[ constraint.objecta ].add( marker );
                    break;

                case 'dof':
                    marker = new THREE.Mesh(
                        new THREE.SphereGeometry( 1.5 ),
                        new THREE.MeshNormalMaterial
                    );
                    marker.position.copy( constraint.positiona );
                    this._objects[ constraint.objecta ].add( marker );
                    break;
            }
        }

        return constraint;
    }
    onSimulationResume() {
        this.execute( 'onSimulationResume', {} );
    }
    removeConstraint( constraint ) {
        if ( this._constraints[ constraint.id ] !== undefined ) {
            this.execute( 'removeConstraint', { id: constraint.id } );
            delete this._constraints[ constraint.id ];
        }
    }
    execute( cmd, params ) {
        this._worker.postMessage( { cmd: cmd, params: params } );
    }
    add( object ) {
        THREE.Mesh.prototype.add.call( this, object );

        if ( object._physijs ) {

            object.world = this;

            if ( object instanceof Physijs.Vehicle ) {

                this.add( object.mesh );
                this._vehicles[ object._physijs.id ] = object;
                this.execute( 'addVehicle', object._physijs );

            } else {

                object.__dirtyPosition = false;
                object.__dirtyRotation = false;
                this._objects[ object._physijs.id ] = object;

                if ( object.children.length ) {
                    object._physijs.children = [];
                    addObjectChildren( object, object );
                }

                if ( object.material._physijs ) {
                    if ( !this._materials_ref_counts.hasOwnProperty( object.material._physijs.id ) ) {
                        this.execute( 'registerMaterial', object.material._physijs );
                        object._physijs.materialId = object.material._physijs.id;
                        this._materials_ref_counts[ object.material._physijs.id ] = 1;
                    } else {
                        this._materials_ref_counts[ object.material._physijs.id ]++;
                    }
                }

                // Object starting position + rotation
                object._physijs.position = { x: object.position.x, y: object.position.y, z: object.position.z };
                object._physijs.rotation = { x: object.quaternion.x, y: object.quaternion.y, z: object.quaternion.z, w: object.quaternion.w };

                // Check for scaling
                let mass_scaling = new THREE.Vector3( 1, 1, 1 );
                if ( object._physijs.width ) {
                    object._physijs.width *= object.scale.x;
                }
                if ( object._physijs.height ) {
                    object._physijs.height *= object.scale.y;
                }
                if ( object._physijs.depth ) {
                    object._physijs.depth *= object.scale.z;
                }
                this.execute( 'addObject', object._physijs );

            }
        }
    }
    remove( object ) {
        if ( object instanceof Physijs.Vehicle ) {
            this.execute( 'removeVehicle', { id: object._physijs.id } );
            while ( object.wheels.length ) {
                this.remove( object.wheels.pop() );
            }
            this.remove( object.mesh );
            delete this._vehicles[ object._physijs.id ];
        } else {
            THREE.Mesh.prototype.remove.call( this, object );
            if ( object._physijs ) {
                delete this._objects[ object._physijs.id ];
                this.execute( 'removeObject', { id: object._physijs.id } );
            }
        }
        if ( object.material && object.material._physijs && this._materials_ref_counts.hasOwnProperty( object.material._physijs.id ) ) {
            this._materials_ref_counts[ object.material._physijs.id ]--;
            if ( this._materials_ref_counts[ object.material._physijs.id ] == 0 ) {
                this.execute( 'unRegisterMaterial', object.material._physijs );
                delete this._materials_ref_counts[ object.material._physijs.id ];
            }
        }
    }
    setFixedTimeStep( fixedTimeStep ) {
        if ( fixedTimeStep ) {
            this.execute( 'setFixedTimeStep', fixedTimeStep );
        }
    }
    setGravity( gravity ) {
        if ( gravity ) {
            this.execute( 'setGravity', gravity );
        }
    }
    simulate( timeStep, maxSubSteps ) {
        let object_id, object, update;

        if ( _is_simulating ) {
            return false;
        }

        _is_simulating = true;

        for ( object_id in this._objects ) {
            if ( !this._objects.hasOwnProperty( object_id ) )
                continue;

            object = this._objects[ object_id ];

            if ( object.__dirtyPosition || object.__dirtyRotation ) {
                update = { id: object._physijs.id };

                if ( object.__dirtyPosition ) {
                    update.pos = { x: object.position.x, y: object.position.y, z: object.position.z };
                    object.__dirtyPosition = false;
                }

                if ( object.__dirtyRotation ) {
                    update.quat = { x: object.quaternion.x, y: object.quaternion.y, z: object.quaternion.z, w: object.quaternion.w };
                    object.__dirtyRotation = false;
                }

                this.execute( 'updateTransform', update );
            }
        }

        this.execute( 'simulate', { timeStep: timeStep, maxSubSteps: maxSubSteps } );

        return true;
    }
}

// Object.assign( Scene.prototype, Eventable.prototype );
Eventable.make( Scene );

function addObjectChildren( parent, object ) {
    for ( let i = 0; i < object.children.length; i++ ) {
        if ( object.children[ i ]._physijs ) {
            object.children[ i ].updateMatrix();
            object.children[ i ].updateMatrixWorld();

            _temp_vector3_1.setFromMatrixPosition( object.children[ i ].matrixWorld );
            _quaternion_1.setFromRotationMatrix( object.children[ i ].matrixWorld );

            object.children[ i ]._physijs.position_offset = {
                x: _temp_vector3_1.x,
                y: _temp_vector3_1.y,
                z: _temp_vector3_1.z
            };

            object.children[ i ]._physijs.rotation = {
                x: _quaternion_1.x,
                y: _quaternion_1.y,
                z: _quaternion_1.z,
                w: _quaternion_1.w
            };

            parent._physijs.children.push( object.children[ i ]._physijs );
        }

        addObjectChildren( parent, object.children[ i ] );
    }
};


// Phsijs.Mesh
class Mesh extends THREE.Mesh {
    constructor( geometry, material, mass ) {

        super( geometry, material );

        Eventable.call( this );

        if ( !geometry ) {
            return;
        }

        if ( !geometry.boundingBox ) {
            geometry.computeBoundingBox();
        }

        this._physijs = {
            type: null,
            id: getObjectId(),
            mass: mass || 0,
            touches: [],
            linearVelocity: new THREE.Vector3,
            angularVelocity: new THREE.Vector3
        };
    }
    // Physijs.Mesh.mass
    get mass() {
        return this._physijs.mass;
    }
    set mass( mass ) {
        this._physijs.mass = mass;
        if ( this.world ) {
            this.world.execute( 'updateMass', { id: this._physijs.id, mass: mass } );
        }
    }
    // Physijs.Mesh.applyCentralImpulse
    applyCentralImpulse( force ) {
        if ( this.world ) {
            this.world.execute( 'applyCentralImpulse', { id: this._physijs.id, x: force.x, y: force.y, z: force.z } );
        }
    }
    // Physijs.Mesh.applyImpulse
    applyImpulse( force, offset ) {
        if ( this.world ) {
            this.world.execute( 'applyImpulse', { id: this._physijs.id, impulse_x: force.x, impulse_y: force.y, impulse_z: force.z, x: offset.x, y: offset.y, z: offset.z } );
        }
    }
    // Physijs.Mesh.applyTorque
    applyTorque( force ) {
        if ( this.world ) {
            this.world.execute( 'applyTorque', { id: this._physijs.id, torque_x: force.x, torque_y: force.y, torque_z: force.z } );
        }
    }
    // Physijs.Mesh.applyCentralForce
    applyCentralForce( force ) {
        if ( this.world ) {
            this.world.execute( 'applyCentralForce', { id: this._physijs.id, x: force.x, y: force.y, z: force.z } );
        }
    }
    // Physijs.Mesh.applyForce
    applyForce( force, offset ) {
        if ( this.world ) {
            this.world.execute( 'applyForce', { id: this._physijs.id, force_x: force.x, force_y: force.y, force_z: force.z, x: offset.x, y: offset.y, z: offset.z } );
        }
    }
    // Physijs.Mesh.getAngularVelocity
    getAngularVelocity() {
        return this._physijs.angularVelocity;
    }
    // Physijs.Mesh.setAngularVelocity
    setAngularVelocity( velocity ) {
        if ( this.world ) {
            this.world.execute( 'setAngularVelocity', { id: this._physijs.id, x: velocity.x, y: velocity.y, z: velocity.z } );
        }
    }
    // Physijs.Mesh.getLinearVelocity
    getLinearVelocity() {
        return this._physijs.linearVelocity;
    }
    // Physijs.Mesh.setLinearVelocity
    setLinearVelocity( velocity ) {
        if ( this.world ) {
            this.world.execute( 'setLinearVelocity', { id: this._physijs.id, x: velocity.x, y: velocity.y, z: velocity.z } );
        }
    }
    // Physijs.Mesh.setAngularFactor
    setAngularFactor( factor ) {
        if ( this.world ) {
            this.world.execute( 'setAngularFactor', { id: this._physijs.id, x: factor.x, y: factor.y, z: factor.z } );
        }
    }
    // Physijs.Mesh.setLinearFactor
    setLinearFactor( factor ) {
        if ( this.world ) {
            this.world.execute( 'setLinearFactor', { id: this._physijs.id, x: factor.x, y: factor.y, z: factor.z } );
        }
    }
    // Physijs.Mesh.setDamping
    setDamping( linear, angular ) {
        if ( this.world ) {
            this.world.execute( 'setDamping', { id: this._physijs.id, linear: linear, angular: angular } );
        }
    }
    // Physijs.Mesh.setCcdMotionThreshold
    setCcdMotionThreshold( threshold ) {
        if ( this.world ) {
            this.world.execute( 'setCcdMotionThreshold', { id: this._physijs.id, threshold: threshold } );
        }
    }
    // Physijs.Mesh.setCcdSweptSphereRadius
    setCcdSweptSphereRadius( radius ) {
        if ( this.world ) {
            this.world.execute( 'setCcdSweptSphereRadius', { id: this._physijs.id, radius: radius } );
        }
    }
}
Eventable.make( Mesh );


// Physijs.PlaneMesh
class PlaneMesh extends Mesh {
    constructor( geometry, material, mass ) {
        super( geometry, material, mass );

        let width, height;

        if ( !geometry.boundingBox ) {
            geometry.computeBoundingBox();
        }

        width = geometry.boundingBox.max.x - geometry.boundingBox.min.x;
        height = geometry.boundingBox.max.y - geometry.boundingBox.min.y;

        this._physijs.type = 'plane';
        this._physijs.normal = geometry.faces[ 0 ].normal.clone();
        this._physijs.mass = ( typeof mass === 'undefined' ) ? width * height : mass;
    }
}

// Physijs.HeightfieldMesh
class HeightfieldMesh extends Mesh {
    constructor( geometry, material, mass, xdiv, ydiv ) {
        super( geometry, material, mass );

        this._physijs.type = 'heightfield';
        this._physijs.xsize = geometry.boundingBox.max.x - geometry.boundingBox.min.x;
        this._physijs.ysize = geometry.boundingBox.max.y - geometry.boundingBox.min.y;
        this._physijs.xpts = ( typeof xdiv === 'undefined' ) ? Math.sqrt( geometry.vertices.length ) : xdiv + 1;
        this._physijs.ypts = ( typeof ydiv === 'undefined' ) ? Math.sqrt( geometry.vertices.length ) : ydiv + 1;
        // note - this assumes our plane geometry is square, unless we pass in specific xdiv and ydiv
        this._physijs.absMaxHeight = Math.max( geometry.boundingBox.max.z, Math.abs( geometry.boundingBox.min.z ) );

        let points = [];

        let a, b;
        for ( let i = 0; i < geometry.vertices.length; i++ ) {

            a = i % this._physijs.xpts;
            b = Math.round( ( i / this._physijs.xpts ) - ( ( i % this._physijs.xpts ) / this._physijs.xpts ) );
            points[ i ] = geometry.vertices[ a + ( ( this._physijs.ypts - b - 1 ) * this._physijs.ypts ) ].z;

            //points[i] = geometry.vertices[i];
        }

        this._physijs.points = points;
    }
}

// Physijs.BoxMesh
class BoxMesh extends Mesh {
    constructor( geometry, material, mass ) {
        super( geometry, material, mass );

        let width, height, depth;

        // if ( !geometry.boundingBox ) {
        geometry.computeBoundingBox();
        // }

        width = geometry.boundingBox.max.x - geometry.boundingBox.min.x;
        height = geometry.boundingBox.max.y - geometry.boundingBox.min.y;
        depth = geometry.boundingBox.max.z - geometry.boundingBox.min.z;

        this._physijs.type = 'box';
        this._physijs.width = width;
        this._physijs.height = height;
        this._physijs.depth = depth;
        this._physijs.mass = ( typeof mass === 'undefined' ) ? width * height * depth : mass;
    }
}


// Physijs.SphereMesh
class SphereMesh extends Mesh {
    constructor( geometry, material, mass ) {
        super( geometry, material, mass );

        if ( !geometry.boundingSphere ) {
            geometry.computeBoundingSphere();
        }

        this._physijs.type = 'sphere';
        this._physijs.radius = geometry.boundingSphere.radius;
        this._physijs.mass = ( typeof mass === 'undefined' ) ? ( 4 / 3 ) * Math.PI * Math.pow( this._physijs.radius, 3 ) : mass;
    }
}


// Physijs.CylinderMesh
class CylinderMesh extends Mesh {
    constructor( geometry, material, mass ) {
        let width, height, depth;

        super( geometry, material, mass );

        if ( !geometry.boundingBox ) {
            geometry.computeBoundingBox();
        }

        width = geometry.boundingBox.max.x - geometry.boundingBox.min.x;
        height = geometry.boundingBox.max.y - geometry.boundingBox.min.y;
        depth = geometry.boundingBox.max.z - geometry.boundingBox.min.z;

        this._physijs.type = 'cylinder';
        this._physijs.width = width;
        this._physijs.height = height;
        this._physijs.depth = depth;
        this._physijs.mass = ( typeof mass === 'undefined' ) ? width * height * depth : mass;
    }
}

// Physijs.CapsuleMesh
class CapsuleMesh extends Mesh {
    constructor( geometry, material, mass ) {
        let width, height, depth;

        super( geometry, material, mass );

        if ( !geometry.boundingBox ) {
            geometry.computeBoundingBox();
        }

        width = geometry.boundingBox.max.x - geometry.boundingBox.min.x;
        height = geometry.boundingBox.max.y - geometry.boundingBox.min.y;
        depth = geometry.boundingBox.max.z - geometry.boundingBox.min.z;

        this._physijs.type = 'capsule';
        this._physijs.radius = Math.max( width / 2, depth / 2 );
        this._physijs.height = height;
        this._physijs.mass = ( typeof mass === 'undefined' ) ? width * height * depth : mass;
    }
}


// Physijs.ConeMesh
class ConeMesh extends Mesh {
    constructor( geometry, material, mass ) {
        let width, height, depth;

        super( geometry, material, mass );

        if ( !geometry.boundingBox ) {
            geometry.computeBoundingBox();
        }

        width = geometry.boundingBox.max.x - geometry.boundingBox.min.x;
        height = geometry.boundingBox.max.y - geometry.boundingBox.min.y;

        this._physijs.type = 'cone';
        this._physijs.radius = width / 2;
        this._physijs.height = height;
        this._physijs.mass = ( typeof mass === 'undefined' ) ? width * height : mass;
    }
}


// Physijs.ConcaveMesh
class ConcaveMesh extends Mesh {
    constructor( geometry, material, mass ) {
        let width, height, depth,
            triangles = [];

        super( geometry, material, mass );

        if ( !geometry.boundingBox ) {
            geometry.computeBoundingBox();
        }

        // add

        const index = geometry.index;
        const position = geometry.attributes.position;

        let a, b, c;

        for ( let i = 0; i < index.count; i += 3 ) {

            a = index.getX( i );
            b = index.getX( i + 1 );
            c = index.getX( i + 2 );

            triangles.push( [
                { x: position.getX( a ), y: position.getY( a ), z: position.getZ( a ) },
                { x: position.getX( b ), y: position.getY( b ), z: position.getZ( b ) },
                { x: position.getX( c ), y: position.getY( c ), z: position.getZ( c ) }
            ] );

        }

        //

        width = geometry.boundingBox.max.x - geometry.boundingBox.min.x;
        height = geometry.boundingBox.max.y - geometry.boundingBox.min.y;
        depth = geometry.boundingBox.max.z - geometry.boundingBox.min.z;

        this._physijs.type = 'concave';
        this._physijs.triangles = triangles;
        this._physijs.mass = ( typeof mass === 'undefined' ) ? width * height * depth : mass;
    }
}

// Physijs.ConvexMesh
class ConvexMesh extends Mesh {
    constructor( geometry, material, mass ) {
        let width, height, depth,
            points = [];

        super( geometry, material, mass );

        if ( !geometry.boundingBox ) {
            geometry.computeBoundingBox();
        }

        // add

        const position = geometry.attributes.position;

        for ( let i = 0; i < position.count; i++ ) {

            points.push( {
                x: position.getX( i ),
                y: position.getY( i ),
                z: position.getZ( i )
            } );

        }

        //

        width = geometry.boundingBox.max.x - geometry.boundingBox.min.x;
        height = geometry.boundingBox.max.y - geometry.boundingBox.min.y;
        depth = geometry.boundingBox.max.z - geometry.boundingBox.min.z;

        this._physijs.type = 'convex';
        this._physijs.points = points;
        this._physijs.mass = ( typeof mass === 'undefined' ) ? width * height * depth : mass;
    }
}

// Physijs.VehicleTuning
class VehicleTuning {
    constructor( suspension_stiffness, suspension_compression, suspension_damping, max_suspension_travel, friction_slip, max_suspension_force ) {
        this.suspension_stiffness = suspension_stiffness ?? 5.88;
        this.suspension_compression = suspension_compression ?? 0.83;
        this.suspension_damping = suspension_damping ?? 0.88;
        this.max_suspension_travel = max_suspension_travel ?? 500;
        this.friction_slip = friction_slip ?? 10.5;
        this.max_suspension_force = max_suspension_force ?? 6000;
    }
}

// Physijs.Vehicle
class Vehicle {
    constructor( mesh, tuning ) {
        tuning = tuning || new VehicleTuning;
        this.mesh = mesh;
        this.wheels = [];
        this._physijs = {
            id: getObjectId(),
            rigidBody: mesh._physijs.id,
            suspension_stiffness: tuning.suspension_stiffness,
            suspension_compression: tuning.suspension_compression,
            suspension_damping: tuning.suspension_damping,
            max_suspension_travel: tuning.max_suspension_travel,
            friction_slip: tuning.friction_slip,
            max_suspension_force: tuning.max_suspension_force
        };
    }
    addWheel( wheel_geometry, wheel_material, connection_point, wheel_direction, wheel_axle, suspension_rest_length, wheel_radius, is_front_wheel, tuning ) {
        let wheel = new THREE.Mesh( wheel_geometry, wheel_material );
        wheel.castShadow = wheel.receiveShadow = true;
        wheel.position.copy( wheel_direction ).multiplyScalar( suspension_rest_length / 100 ).add( connection_point );
        this.world.add( wheel );
        this.wheels.push( wheel );

        this.world.execute( 'addWheel', {
            id: this._physijs.id,
            connection_point: { x: connection_point.x, y: connection_point.y, z: connection_point.z },
            wheel_direction: { x: wheel_direction.x, y: wheel_direction.y, z: wheel_direction.z },
            wheel_axle: { x: wheel_axle.x, y: wheel_axle.y, z: wheel_axle.z },
            suspension_rest_length: suspension_rest_length,
            wheel_radius: wheel_radius,
            is_front_wheel: is_front_wheel,
            tuning: tuning
        } );
    }
    setSteering( amount, wheel ) {
        if ( wheel !== undefined && this.wheels[ wheel ] !== undefined ) {
            this.world.execute( 'setSteering', { id: this._physijs.id, wheel: wheel, steering: amount } );
        } else if ( this.wheels.length > 0 ) {
            for ( let i = 0; i < this.wheels.length; i++ ) {
                this.world.execute( 'setSteering', { id: this._physijs.id, wheel: i, steering: amount } );
            }
        }
    }
    setBrake( amount, wheel ) {
        if ( wheel !== undefined && this.wheels[ wheel ] !== undefined ) {
            this.world.execute( 'setBrake', { id: this._physijs.id, wheel: wheel, brake: amount } );
        } else if ( this.wheels.length > 0 ) {
            for ( let i = 0; i < this.wheels.length; i++ ) {
                this.world.execute( 'setBrake', { id: this._physijs.id, wheel: i, brake: amount } );
            }
        }
    }
    applyEngineForce( amount, wheel ) {
        if ( wheel !== undefined && this.wheels[ wheel ] !== undefined ) {
            this.world.execute( 'applyEngineForce', { id: this._physijs.id, wheel: wheel, force: amount } );
        } else if ( this.wheels.length > 0 ) {
            for ( let i = 0; i < this.wheels.length; i++ ) {
                this.world.execute( 'applyEngineForce', { id: this._physijs.id, wheel: i, force: amount } );
            }
        }
    }
}

export let Physijs = {
    // scripts: { worker: './physijs_worker.js', ammo: './ammo.js' }
    scripts: {},
    BoxMesh,
    CapsuleMesh,
    ConcaveMesh,
    ConeMesh,
    ConvexMesh,
    CylinderMesh,
    Mesh,

    PlaneMesh,
    SphereMesh,
    HeightfieldMesh,
    ConeTwistConstraint,
    DOFConstraint,
    HingeConstraint,
    PointConstraint,
    SliderConstraint,

    Scene,

    Vehicle,
    VehicleTuning,

    createMaterial,
    noConflict,
}