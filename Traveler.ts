/**
 * To start using Traveler, require it in main.js:
 * Example: var Traveler = require('Traveler.js');
 */

export class Traveler {
  private static structureMatrixCache: { [roomName: string]: CostMatrix } = {};
  private static creepMatrixCache: { [roomName: string]: CostMatrix } = {};
  private static creepMatrixTick: { [roomName: string]: number } = {};
  private static structureMatrixTick: { [roomName: string]: number } = {};

  /**
   * move creep to destination
   * @param creep
   * @param destination
   * @param options
   * @returns {number}
   */

  public static travelTo(creep: Creep, destPos: HasPos | RoomPosition, options: TravelToOptions = {}): number {
    // uncomment if you would like to register hostile rooms entered
    this.updateRoomStatus(creep.room);

    if (creep.spawning) {
      return ERR_BUSY;
    }

    if (!destPos) {
      return ERR_INVALID_ARGS;
    }

    if (creep.fatigue > 0) {
      Traveler.circle(creep.pos, 'aqua', 0.3);
      return ERR_TIRED;
    }

    const destination = this.normalizePos(destPos);

    // manage case where creep is nearby destination
    const rangeToDestination = creep.pos.getRangeTo(destination);
    if (options.range && rangeToDestination <= options.range) {
      return OK;
    } else if (rangeToDestination <= 1) {
      if (rangeToDestination === 1 && !options.range) {
        const direction = creep.pos.getDirectionTo(destination);
        if (options.returnData) {
          options.returnData.nextDir = direction;
          options.returnData.nextPos = destination;
          options.returnData.path = direction.toString();
        }
        return options.justPath ? OK : creep.move(direction);
      }
      return OK;
    }

    // initialize data object
    const travelData: TravelData = creep.memory._trav ?? {};
    creep.memory._trav = travelData;

    const state = this.deserializeState(travelData, destination);

    // Indicate an invocation of travelTo occurred
    ++state.numTravelTo;

    // uncomment to visualize destination
    // this.circle(destination, "orange");

    // check if creep is stuck
    if (this.isStuck(creep, state)) {
      state.stuckCount++;
      Traveler.circle(creep.pos, 'magenta', state.stuckCount * 0.2);
    } else {
      state.stuckCount = 0;
    }

    // handle case where creep is stuck
    if (!options.stuckValue) {
      options.stuckValue = DEFAULT_STUCK_VALUE;
    }
    if (state.stuckCount >= options.stuckValue && Math.random() > 0.5) {
      options.ignoreCreeps = false;
      options.freshMatrix = true;
      delete travelData.path;
    }

    // TODO:handle case where creep moved by some other function, but destination is still the same

    // delete path cache if destination is different
    if (!this.samePos(state.destination, destination)) {
      if (state.destination.isNearTo(destination)) {
        const dir = state.destination.getDirectionTo(destination);
        if (travelData.path) {
          travelData.path += dir;
        } else {
          travelData.path = dir.toString();
        }
        state.destination = destination;
      } else {
        delete travelData.path;
      }
    }

    if (options.repath && Math.random() < options.repath) {
      // add some chance that you will find a new path randomly
      delete travelData.path;
    }

    // pathfinding
    let newPath = false;
    if (!travelData.path) {
      newPath = true;
      state.destination = destination;

      const cpu = Game.cpu.getUsed();
      const ret = this.findTravelPath(creep.pos, destination, options);
      const cpuUsed = Game.cpu.getUsed() - cpu;
      state.cpu = _.round(cpuUsed + state.cpu);
      ++state.numRepaths;

      const age = creep.age();
      const cpuPerLifeTick = state.cpu / age;
      const repathRatio = state.numRepaths / state.numTravelTo;
      if (age > 20 && (cpuPerLifeTick > REPORT_MAX_CPU_PER_LIFETICK || repathRatio > REPORT_MAX_REPATH_RATIO)) {
        // see note at end of file for more info on this
        console.log(
          `TRAVELER: heavy cpu for ${creep.name}: cpu=${state.cpu}/${age}=${cpuPerLifeTick.toFixed(2)},repathRatio=${
            state.numRepaths
          }/${state.numTravelTo}=${repathRatio.toFixed(2)},${creep.pos}=>${destination}`
        );
      }

      let color = 'orange';
      if (ret.incomplete) {
        // uncommenting this is a great way to diagnose creep behavior issues
        console.log(`TRAVELER: incomplete path for ${creep.name}: ${creep.pos}=>${destination}`);
        color = 'red';
      }

      if (options.returnData) {
        options.returnData.pathfinderReturn = ret;
      }

      travelData.path = Traveler.serializePath(creep.pos, ret.path, color);
      state.stuckCount = 0;
    }

    this.serializeState(creep, destination, state, travelData);

    if (!travelData.path || travelData.path.length === 0) {
      return ERR_NO_PATH;
    }

    // consume path
    if (state.stuckCount === 0 && !newPath) {
      travelData.path = travelData.path.substr(1);
    }

    const nextDirection = parseInt(travelData.path[0], 10) as DirectionConstant;
    if (options.returnData) {
      if (nextDirection) {
        const nextPos = Traveler.positionAtDirection(creep.pos, nextDirection);
        options.returnData.nextDir = nextDirection;
        if (nextPos) {
          options.returnData.nextPos = nextPos;
        }
      }
      options.returnData.state = state;
      options.returnData.path = travelData.path;
    }
    return options.justPath ? OK : creep.move(nextDirection);
  }

  /**
   * make position objects consistent so that either can be used as an argument
   * @param destination
   * @returns {any}
   */

  public static normalizePos(destination: HasPos | RoomPosition): RoomPosition {
    if (!(destination instanceof RoomPosition)) {
      return destination.pos;
    }
    return destination;
  }

  /**
   * check if room should be avoided by findRoute algorithm
   * @param roomName
   * @returns {RoomMemory|number}
   */

  public static checkAvoid(roomName: string): boolean {
    return Memory.rooms[roomName]?.avoid ?? false;
  }

  /**
   * check if a position is an exit
   * @param pos
   * @returns {boolean}
   */

  public static isExit(pos: Coord): boolean {
    return pos.x === 0 || pos.y === 0 || pos.x === 49 || pos.y === 49;
  }

  /**
   * check two coordinates match
   * @param pos1
   * @param pos2
   * @returns {boolean}
   */

  public static sameCoord(pos1: Coord, pos2: Coord): boolean {
    return pos1.x === pos2.x && pos1.y === pos2.y;
  }

  /**
   * check if two positions match
   * @param pos1
   * @param pos2
   * @returns {boolean}
   */

  public static samePos(pos1: RoomPosition, pos2: RoomPosition) {
    return this.sameCoord(pos1, pos2) && pos1.roomName === pos2.roomName;
  }

  /**
   * draw a circle at position
   * @param pos
   * @param color
   * @param opacity
   */

  public static circle(pos: RoomPosition, color: string, opacity?: number) {
    new RoomVisual(pos.roomName).circle(pos, {
      radius: 0.45,
      fill: 'transparent',
      stroke: color,
      strokeWidth: 0.15,
      opacity: opacity
    });
  }

  /**
   * update memory on whether a room should be avoided based on controller owner
   * @param room
   */

  public static updateRoomStatus(room: Room) {
    if (!room) {
      return;
    }
    if (room.controller) {
      if (room.controller.owner && !room.controller.my) {
        room.memory.avoid = true;
      } else {
        delete room.memory.avoid;
      }
    }
  }

  /**
   * find a path from origin to destination
   * @param origin
   * @param destination
   * @param options
   * @returns {PathfinderReturn}
   */

  public static findTravelPath(
    originPos: RoomPosition | HasPos,
    destinationPos: RoomPosition | HasPos,
    options: TravelToOptions = {}
  ): PathfinderReturn {
    _.defaults(options, {
      ignoreCreeps: true,
      maxOps: DEFAULT_MAXOPS,
      range: 1
    });

    if (options.movingTarget) {
      options.range = 0;
    }

    const origin = this.normalizePos(originPos);
    const destination = this.normalizePos(destinationPos);
    const originRoomName = origin.roomName;
    const destRoomName = destination.roomName;

    // check to see whether findRoute should be used
    const roomDistance = Game.map.getRoomLinearDistance(origin.roomName, destination.roomName);
    let allowedRooms = options.route;
    if (!allowedRooms && (options.useFindRoute || (options.useFindRoute === undefined && roomDistance > 2))) {
      const route = this.findRoute(origin.roomName, destination.roomName, options);
      if (route) {
        allowedRooms = route;
      }
    }

    const callback = (roomName: string): CostMatrix | boolean => {
      if (allowedRooms) {
        if (!allowedRooms[roomName]) {
          return false;
        }
      } else if (
        !options.allowHostile &&
        Traveler.checkAvoid(roomName) &&
        roomName !== destRoomName &&
        roomName !== originRoomName
      ) {
        return false;
      }

      let matrix: CostMatrix | undefined;
      const room = Game.rooms[roomName];
      if (!room) {
        return new PathFinder.CostMatrix();
      }
      if (options.ignoreStructures) {
        matrix = new PathFinder.CostMatrix();
        if (!options.ignoreCreeps) {
          Traveler.addCreepsToMatrix(room, matrix);
        }
      } else if (options.ignoreCreeps || roomName !== originRoomName) {
        matrix = this.getStructureMatrix(room, options.freshMatrix);
      } else {
        matrix = this.getCreepMatrix(room);
      }

      if (options.obstacles) {
        matrix = matrix.clone();
        for (const obstacle of options.obstacles) {
          if (obstacle.pos.roomName !== roomName) {
            continue;
          }
          matrix.set(obstacle.pos.x, obstacle.pos.y, 0xff);
        }
      }

      if (options.roomCallback) {
        if (!matrix) {
          matrix = new PathFinder.CostMatrix();
        }
        const outcome = options.roomCallback(roomName, matrix.clone());
        if (outcome !== undefined) {
          return outcome;
        }
      }

      return matrix;
    };

    let ret = PathFinder.search(
      origin,
      { pos: destination, range: options.range ?? 1 },
      {
        maxOps: options.maxOps,
        maxRooms: options.maxRooms,
        plainCost: options.offRoad ? 1 : options.ignoreRoads ? 1 : 2,
        swampCost: options.offRoad ? 1 : options.ignoreRoads ? 5 : 10,
        roomCallback: callback
      }
    );

    if (ret.incomplete && options.ensurePath) {
      if (options.useFindRoute === undefined) {
        // handle case where pathfinder failed at a short distance due to not using findRoute
        // can happen for situations where the creep would have to take an uncommonly indirect path
        // options.allowedRooms and options.routeCallback can also be used to handle this situation
        if (roomDistance <= 2) {
          console.log('TRAVELER: path failed without findroute, trying with options.useFindRoute = true');
          console.log(`from: ${origin}, destination: ${destination}`);
          options.useFindRoute = true;
          ret = this.findTravelPath(origin, destination, options);
          console.log(`TRAVELER: second attempt was ${ret.incomplete ? 'not ' : ''}successful`);
          return ret;
        }

        // TODO: handle case where a wall or some other obstacle is blocking the exit assumed by findRoute
      } else {
      }
    }

    return ret;
  }

  public static roomCoord(roomName: string): { x: number; y: number } {
    const parsed = /^[WE]([0-9]+)[NS]([0-9]+)$/.exec(roomName)!;
    return { x: Number(parsed[1]), y: Number(parsed[2]) };
  }

  public static isHighway(roomCoord: { x: number; y: number }): boolean {
    return roomCoord.x % 10 === 0 || roomCoord.y % 10 === 0;
  }

  public static isSkRoom(roomCoord: { x: number; y: number }): boolean {
    const fMod = roomCoord.x % 10;
    const sMod = roomCoord.y % 10;
    return !(fMod === 5 && sMod === 5) && fMod >= 4 && fMod <= 6 && sMod >= 4 && sMod <= 6;
  }
  /**
   * find a viable sequence of rooms that can be used to narrow down pathfinder's search algorithm
   * @param origin
   * @param destination
   * @param options
   * @returns {{}}
   */

  public static findRoute(
    origin: string,
    destination: string,
    options: TravelToOptions = {}
  ): { [roomName: string]: boolean } | void {
    const restrictDistance = options.restrictDistance || Game.map.getRoomLinearDistance(origin, destination) + 10;
    const allowedRooms = { [origin]: true, [destination]: true };

    let highwayBias = 1;
    if (options.preferHighway) {
      highwayBias = 2.5;
      if (options.highwayBias) {
        highwayBias = options.highwayBias;
      }
    }

    const ret = Game.map.findRoute(origin, destination, {
      routeCallback: (roomName: string) => {
        if (options.routeCallback) {
          const outcome = options.routeCallback(roomName);
          if (outcome !== undefined) {
            return outcome;
          }
        }

        const rangeToRoom = Game.map.getRoomLinearDistance(origin, roomName);
        if (rangeToRoom > restrictDistance) {
          // room is too far out of the way
          return Number.POSITIVE_INFINITY;
        }

        if (!options.allowHostile && Traveler.checkAvoid(roomName) && roomName !== destination && roomName !== origin) {
          // room is marked as "avoid" in room memory
          return Number.POSITIVE_INFINITY;
        }

        const roomCoord = this.roomCoord(roomName);
        if (options.preferHighway) {
          if (this.isHighway(roomCoord)) {
            return 1;
          }
        }

        // SK rooms are avoided when there is no vision in the room, harvested-from SK rooms are allowed
        if (!options.allowSK && !Game.rooms[roomName]) {
          if (this.isSkRoom(roomCoord)) {
            return 10 * highwayBias;
          }
        }

        return highwayBias;
      }
    });

    if (!_.isArray(ret)) {
      console.log(`TRAVELER: couldn't findRoute to ${destination}`);
      return;
    }
    for (const value of ret) {
      allowedRooms[value.room] = true;
    }

    return allowedRooms;
  }

  /**
   * check how many rooms were included in a route returned by findRoute
   * @param origin
   * @param destination
   * @returns {number}
   */

  public static routeDistance(origin: string, destination: string): number | void {
    const linearDistance = Game.map.getRoomLinearDistance(origin, destination);
    if (linearDistance >= 32) {
      return linearDistance;
    }

    const allowedRooms = this.findRoute(origin, destination);
    if (allowedRooms) {
      return Object.keys(allowedRooms).length;
    }
  }

  /**
   * build a cost matrix based on structures in the room. Will be cached for more than one tick. Requires vision.
   * @param room
   * @param freshMatrix
   * @returns {any}
   */

  public static getStructureMatrix(room: Room, freshMatrix?: boolean): CostMatrix {
    if (!this.structureMatrixCache[room.name] || (freshMatrix && Game.time !== this.structureMatrixTick[room.name])) {
      this.structureMatrixTick[room.name] = Game.time;
      const matrix = new PathFinder.CostMatrix();
      this.structureMatrixCache[room.name] = Traveler.addStructuresToMatrix(room, matrix, 1);
    }
    return this.structureMatrixCache[room.name];
  }

  /**
   * build a cost matrix based on creeps and structures in the room. Will be cached for one tick. Requires vision.
   * @param room
   * @returns {any}
   */

  public static getCreepMatrix(room: Room) {
    if (!this.creepMatrixCache[room.name] || Game.time !== this.creepMatrixTick[room.name]) {
      this.creepMatrixTick[room.name] = Game.time;
      this.creepMatrixCache[room.name] = Traveler.addCreepsToMatrix(room, this.getStructureMatrix(room, true).clone());
    }
    return this.creepMatrixCache[room.name];
  }

  /**
   * add structures to matrix so that impassible structures can be avoided and roads given a lower cost
   * @param room
   * @param matrix
   * @param roadCost
   * @returns {CostMatrix}
   */

  public static addStructuresToMatrix(room: Room, matrix: CostMatrix, roadCost: number): CostMatrix {
    const impassibleStructures: Structure[] = [];
    for (const structure of room.find(FIND_STRUCTURES)) {
      if (structure instanceof StructureRampart) {
        if (!structure.my && !structure.isPublic) {
          impassibleStructures.push(structure);
        }
      } else if (structure instanceof StructureRoad) {
        matrix.set(structure.pos.x, structure.pos.y, roadCost);
      } else if (structure instanceof StructureContainer) {
        matrix.set(structure.pos.x, structure.pos.y, 5);
      } else {
        impassibleStructures.push(structure);
      }
    }

    for (const site of room.find(FIND_MY_CONSTRUCTION_SITES)) {
      if (
        site.structureType === STRUCTURE_CONTAINER ||
        site.structureType === STRUCTURE_ROAD ||
        site.structureType === STRUCTURE_RAMPART
      ) {
        continue;
      }
      matrix.set(site.pos.x, site.pos.y, 0xff);
    }

    for (const structure of impassibleStructures) {
      matrix.set(structure.pos.x, structure.pos.y, 0xff);
    }

    return matrix;
  }

  /**
   * add creeps to matrix so that they will be avoided by other creeps
   * @param room
   * @param matrix
   * @returns {CostMatrix}
   */

  public static addCreepsToMatrix(room: Room, matrix: CostMatrix): CostMatrix {
    room.find(FIND_CREEPS).forEach((creep: Creep) => matrix.set(creep.pos.x, creep.pos.y, 0xff));
    return matrix;
  }

  /**
   * Returns the path length of a creep
   * @param creep
   * @returns {number}
   */

  public static pathLength(creep: Creep): number {
    const path = creep.memory._trav?.path ?? '';
    return path.length;
  }

  public static path(creep: Creep): RoomPosition[] {
    const pathStr = creep.memory._trav?.path;
    if (!pathStr || pathStr.length === 0) {
      return [];
    }

    const path: RoomPosition[] = [];
    let pos = creep.pos;
    for (let i = 0; i < pathStr.length; ++i) {
      const dir = parseInt(pathStr[i]) as DirectionConstant;
      const res = this.positionAtDirection(pos, dir);
      if (!res) {
        break;
      }
      pos = res;
      path.push(pos);
    }
    return path;
  }

  public static nextPos(creep: Creep, nth = 1): RoomPosition | undefined {
    let pos = creep.pos;
    const pathStr = creep.memory._trav?.path;
    if (!pathStr) {
      return undefined;
    }

    for (let i = 0; i < nth; ++i) {
      const dir = parseInt(pathStr[i]) as DirectionConstant;
      const res = this.positionAtDirection(pos, dir);
      if (!res) {
        return undefined;
      }
      pos = res;
    }
    return pos;
  }

  public static backstep(creep: Creep, toPos: RoomPosition) {
    if (this.pathLength(creep) === 0) {
      // log.warning(`${creep}: tried to backstep with no memory of movement.`);
      return;
    }

    const dir = creep.pos.getDirectionTo(toPos);
    const opDir = this.oppositeDirection(dir);
    const trav = creep.memory._trav;
    if (!trav) {
      return;
    }
    const oldPath = trav.path;
    if (!oldPath) {
      return;
    }

    if (creep.fatigue === 0) {
      const res = creep.move(dir);
      if (res === OK) {
        const newPath = `${opDir}${oldPath}`;
        trav.path = newPath;
      }
    } else {
      // Add extra movements to backstep, then return
      const newPath = `${dir}${opDir}${oldPath}`;
      // log.error(`${toPos.roomName}: ${creep} backstepping. newPath=${newPath}, oldPath=${oldPath}`);
      trav.path = newPath;
    }
  }

  /**
   * serialize a path, traveler style. Returns a string of directions.
   * @param startPos
   * @param path
   * @param color
   * @returns {string}
   */

  public static serializePath(startPos: RoomPosition, path: RoomPosition[], color = 'orange'): string {
    let serializedPath = '';
    let lastPosition = startPos;
    this.circle(startPos, color);
    for (const position of path) {
      if (position.roomName === lastPosition.roomName) {
        new RoomVisual(position.roomName).line(position, lastPosition, { color: color, lineStyle: 'dashed' });
        serializedPath += lastPosition.getDirectionTo(position);
      }
      lastPosition = position;
    }
    return serializedPath;
  }

  /**
   * returns a position at a direction relative to origin
   * @param origin
   * @param direction
   * @returns {RoomPosition}
   */

  public static positionAtDirection(origin: RoomPosition, direction: number): RoomPosition | void {
    const offsetX = [0, 0, 1, 1, 1, 0, -1, -1, -1];
    const offsetY = [0, -1, -1, 0, 1, 1, 1, 0, -1];
    const x = origin.x + offsetX[direction];
    const y = origin.y + offsetY[direction];
    if (x > 49 || x < 0 || y > 49 || y < 0) {
      return;
    }
    return new RoomPosition(x, y, origin.roomName);
  }

  public static oppositeDirection(dir: DirectionConstant): DirectionConstant {
    switch (dir) {
      default:
      case TOP:
        return BOTTOM;
      case TOP_RIGHT:
        return BOTTOM_LEFT;
      case TOP_LEFT:
        return BOTTOM_RIGHT;
      case BOTTOM:
        return TOP;
      case BOTTOM_RIGHT:
        return TOP_LEFT;
      case BOTTOM_LEFT:
        return TOP_RIGHT;
    }
  }

  /**
   * convert room avoidance memory from the old pattern to the one currently used
   * @param cleanup
   */

  private static deserializeState(travelData: TravelData, destination: RoomPosition): TravelState {
    const state = {} as TravelState;
    if (travelData.state) {
      state.lastCoord = { x: travelData.state.prevX, y: travelData.state.prevY };
      state.cpu = travelData.state.cpu;
      state.numRepaths = travelData.state.numRepaths ?? 0;
      state.numTravelTo = travelData.state.numTravelTo ?? 0;
      state.stuckCount = travelData.state.stuck;
      state.destination = new RoomPosition(travelData.state.destX, travelData.state.destY, travelData.state.roomName);
    } else {
      state.cpu = 0;
      state.numRepaths = 0;
      state.numTravelTo = 0;
      state.destination = destination;
    }
    return state;
  }

  private static serializeState(creep: Creep, destination: RoomPosition, state: TravelState, travelData: TravelData) {
    travelData.state = {
      prevX: creep.pos.x,
      prevY: creep.pos.y,
      stuck: state.stuckCount,
      cpu: state.cpu,
      numRepaths: state.numRepaths,
      numTravelTo: state.numTravelTo,
      destX: destination.x,
      destY: destination.y,
      roomName: destination.roomName
    };
  }

  private static isStuck(creep: Creep, state: TravelState): boolean {
    let stuck = false;
    if (state.lastCoord !== undefined) {
      if (this.sameCoord(creep.pos, state.lastCoord)) {
        // didn't move
        stuck = true;
      } else if (this.isExit(creep.pos) && this.isExit(state.lastCoord)) {
        // moved against exit
        stuck = true;
      }
    }

    return stuck;
  }
}

// this might be higher than you wish, setting it lower is a great way to diagnose creep behavior issues. When creeps
// need to repath to often or they aren't finding valid paths, it can sometimes point to problems elsewhere in your code
const REPORT_MAX_CPU_PER_LIFETICK = 0.25;
const REPORT_MAX_REPATH_RATIO = 0.2;
const DEFAULT_MAXOPS = 20000;
const DEFAULT_STUCK_VALUE = 2;

// assigns a function to Creep.prototype: creep.travelTo(destination)
Creep.prototype.travelTo = function (destination: RoomPosition | { pos: RoomPosition }, options?: TravelToOptions) {
  return Traveler.travelTo(this, destination, options);
};
