/**
 * LPU Map - Directions Controller (Panel 2 & Navigation)
 * Full Topological Campus Road Graph Pathfinder + Instant Geocoding + Dot Route Renderer.
 */

/* ============================================================================
   Campus Road Network Graph (A* Dijkstra Pathfinder)
   ============================================================================ */
class CampusRoadGraph {
  constructor() {
    this.nodes = new Map(); // id -> { id, lat, lng, neighbors: [], hasFootEdge, hasVehEdge, wayIds: Set, isEndpoint }
    this.segments = []; // array of segments for orthogonal projection
    this.initialized = false;
  }

  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  getNodeId(lat, lng) {
    return `${lat.toFixed(6)},${lng.toFixed(6)}`;
  }

  // Orthogonal projection of coordinate P onto line segment [A, B]
  projectPointOnSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
    const dx = bLng - aLng;
    const dy = bLat - aLat;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { lat: aLat, lng: aLng, t: 0 };

    let t = ((pLng - aLng) * dx + (pLat - aLat) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    return {
      lat: aLat + t * dy,
      lng: aLng + t * dx,
      t
    };
  }

  buildGraph(roadDataOverride) {
    if (this.initialized) return;
    let roadData = roadDataOverride;
    if (!roadData || !roadData.length) {
      if (typeof window !== "undefined" && window.CAMPUS_ROADS_DATA && Array.isArray(window.CAMPUS_ROADS_DATA) && window.CAMPUS_ROADS_DATA.length > 0) {
        roadData = window.CAMPUS_ROADS_DATA;
      } else if (typeof window !== "undefined" && window.CampusMap && window.CampusMap.geoJsonData && (window.CampusMap.geoJsonData.roads || window.CampusMap.geoJsonData.footpaths)) {
        return this.buildGraphFromGeoJson(window.CampusMap.geoJsonData.roads, window.CampusMap.geoJsonData.footpaths);
      }
    }
    if (!roadData || roadData.length === 0) return;

    this.nodes.clear();
    this.segments = [];

    const getOrCreateNode = (lat, lng, wayId) => {
      const id = this.getNodeId(lat, lng);
      if (!this.nodes.has(id)) {
        this.nodes.set(id, {
          id,
          lat,
          lng,
          neighbors: [],
          hasFootEdge: false,
          hasVehEdge: false,
          wayIds: new Set(),
          isEndpoint: false
        });
      }
      const n = this.nodes.get(id);
      if (wayId) n.wayIds.add(wayId);
      return n;
    };

    // 1. Build sequential edges along ways (strict curve & geometry preservation)
    roadData.forEach(way => {
      const coords = way.coords || [];
      const tags = way.tags || {};
      const highway = tags.highway || 'road';

      const isPedestrianOnly = ['footway', 'path', 'steps', 'pedestrian'].includes(highway);
      // On campus, pedestrian walkways and shared campus roads are walkable by foot
      const isFoot = true;
      // Vehicles are strictly allowed only on drivable roads, forbidden on footpaths and steps
      const isVeh = !isPedestrianOnly;
      const isOneway = tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout';

      for (let i = 0; i < coords.length - 1; i++) {
        const [lat1, lng1] = coords[i];
        const [lat2, lng2] = coords[i + 1];

        const node1 = getOrCreateNode(lat1, lng1, way.id);
        const node2 = getOrCreateNode(lat2, lng2, way.id);

        if (i === 0) node1.isEndpoint = true;
        if (i === coords.length - 2) node2.isEndpoint = true;

        const dist = this.haversineDistance(lat1, lng1, lat2, lng2);

        if (isFoot) {
          node1.hasFootEdge = true;
          node2.hasFootEdge = true;
        }
        if (isVeh) {
          node1.hasVehEdge = true;
          node2.hasVehEdge = true;
        }

        const id1 = node1.id;
        const id2 = node2.id;

        // Forward edge
        node1.neighbors.push({
          id: id2,
          dist,
          highway,
          isFoot,
          isVeh,
          isOneway,
          wayId: way.id,
          forward: true
        });

        // Reverse edge
        node2.neighbors.push({
          id: id1,
          dist,
          highway,
          isFoot,
          isVeh: isVeh && !isOneway,
          isOneway,
          wayId: way.id,
          forward: false
        });

        // Store road segment for orthogonal projection
        this.segments.push({
          p1: [lat1, lng1],
          p2: [lat2, lng2],
          id1,
          id2,
          dist,
          isFoot,
          isVeh,
          isOneway,
          wayId: way.id,
          highway
        });
      }
    });

    // 2. Connect legitimate intersections ONLY between DIFFERENT ways at endpoints (tolerance ~8.5m)
    // CRUCIAL: Never connect non-consecutive nodes belonging to the same way (preserves curved roads, bends, and roundabouts!)
    const allNodes = Array.from(this.nodes.values());
    const endpoints = allNodes.filter(n => n.isEndpoint);

    endpoints.forEach(ep => {
      allNodes.forEach(other => {
        if (ep.id === other.id) return;
        // Never connect if both nodes share a way (NO SHORTCUTS ALONG CURVED ROADS)
        let sharesWay = false;
        for (const w of ep.wayIds) {
          if (other.wayIds.has(w)) {
            sharesWay = true;
            break;
          }
        }
        if (sharesWay) return;

        const d = this.haversineDistance(ep.lat, ep.lng, other.lat, other.lng);
        if (d <= 8.5) {
          const vehJunction = ep.hasVehEdge && other.hasVehEdge;
          ep.neighbors.push({
            id: other.id,
            dist: d,
            highway: 'junction',
            isFoot: true,
            isVeh: vehJunction,
            isOneway: false,
            isTransition: true,
            forward: true
          });
          other.neighbors.push({
            id: ep.id,
            dist: d,
            highway: 'junction',
            isFoot: true,
            isVeh: vehJunction,
            isOneway: false,
            isTransition: true,
            forward: true
          });
        }
      });
    });

    // 3. Bridge disconnected network components so no campus location ever hits a straight-line fallback
    this.bridgeComponents();

    this.initialized = true;
  }

  bridgeComponents() {
    const visited = new Set();
    const components = [];

    for (const id of this.nodes.keys()) {
      if (!visited.has(id)) {
        const comp = [];
        const q = [id];
        visited.add(id);
        while (q.length > 0) {
          const curr = q.pop();
          comp.push(curr);
          const node = this.nodes.get(curr);
          if (node) {
            for (const neighbor of node.neighbors) {
              if (!visited.has(neighbor.id)) {
                visited.add(neighbor.id);
                q.push(neighbor.id);
              }
            }
          }
        }
        components.push(comp);
      }
    }

    if (components.length <= 1) return;
    components.sort((a, b) => b.length - a.length);

    const mainComp = components[0];
    for (let c = 1; c < components.length; c++) {
      const otherComp = components[c];
      let minDist = Infinity;
      let bestMainId = null;
      let bestOtherId = null;

      for (const id1 of otherComp) {
        const n1 = this.nodes.get(id1);
        for (const id2 of mainComp) {
          const n2 = this.nodes.get(id2);
          const d = this.haversineDistance(n1.lat, n1.lng, n2.lat, n2.lng);
          if (d < minDist) {
            minDist = d;
            bestOtherId = id1;
            bestMainId = id2;
          }
        }
      }

      if (bestOtherId && bestMainId && minDist < 50) {
        const n1 = this.nodes.get(bestOtherId);
        const n2 = this.nodes.get(bestMainId);
        const veh = n1.hasVehEdge && n2.hasVehEdge;
        n1.neighbors.push({
          id: bestMainId,
          dist: minDist,
          highway: 'bridge',
          isFoot: true,
          isVeh: veh,
          isOneway: false,
          isTransition: true,
          forward: true
        });
        n2.neighbors.push({
          id: bestOtherId,
          dist: minDist,
          highway: 'bridge',
          isFoot: true,
          isVeh: veh,
          isOneway: false,
          isTransition: true,
          forward: true
        });
        otherComp.forEach(id => mainComp.push(id));
      }
    }
  }

  // Snap to closest road segment with exact orthogonal projected coordinate
  snapToNetwork(lat, lng, mode = 'walking') {
    let bestProj = null;
    let minDist = Infinity;
    let bestSeg = null;

    for (const seg of this.segments) {
      if (mode === 'drive' || mode === 'kart' || mode === 'moto') {
        if (!seg.isVeh) continue;
      } else {
        if (!seg.isFoot) continue;
      }

      const proj = this.projectPointOnSegment(lat, lng, seg.p1[0], seg.p1[1], seg.p2[0], seg.p2[1]);
      const d = this.haversineDistance(lat, lng, proj.lat, proj.lng);
      if (d < minDist) {
        minDist = d;
        bestProj = proj;
        bestSeg = seg;
      }
    }

    if (!bestSeg) {
      let bestNodeId = null;
      let minNodeDist = Infinity;
      for (const [id, node] of this.nodes.entries()) {
        const d = this.haversineDistance(lat, lng, node.lat, node.lng);
        if (d < minNodeDist) {
          minNodeDist = d;
          bestNodeId = id;
        }
      }
      const node = this.nodes.get(bestNodeId);
      return {
        lat: node ? node.lat : lat,
        lng: node ? node.lng : lng,
        dist: minNodeDist,
        nearestNodeId: bestNodeId,
        seg: null,
        t: 0
      };
    }

    return {
      lat: bestProj.lat,
      lng: bestProj.lng,
      dist: minDist,
      seg: bestSeg,
      node1Id: bestSeg.id1,
      node2Id: bestSeg.id2,
      t: bestProj.t
    };
  }

  findNearestNode(lat, lng, mode = 'walking') {
    const snap = this.snapToNetwork(lat, lng, mode);
    if (snap.seg) {
      return snap.t < 0.5 ? snap.seg.id1 : snap.seg.id2;
    }
    return snap.nearestNodeId;
  }

  getEdgeCost(edge, mode = 'walking') {
    if (mode === 'drive' || mode === 'kart' || mode === 'moto') {
      if (edge.highway === 'steps' || edge.highway === 'footway' || edge.highway === 'pedestrian' || edge.highway === 'path') {
        return Infinity;
      }
      if (!edge.isVeh) return Infinity;
      return edge.dist * 1.0;
    }

    // Walking mode:
    if (edge.highway === 'footway' || edge.highway === 'path' || edge.highway === 'pedestrian') {
      return edge.dist * 1.0;
    }
    if (edge.highway === 'steps') {
      return edge.dist * 1.1;
    }
    // Shared campus roads: gentle 1.15 multiplier guarantees true shortest path without detour penalties
    return edge.dist * 1.15;
  }

  // Multi-modal A* Shortest Path Search with curve preservation
  findPath(startLat, startLng, endLat, endLng, mode = 'walking') {
    this.buildGraph();
    if (this.nodes.size === 0) return null;

    const startSnap = this.snapToNetwork(startLat, startLng, mode);
    const endSnap = this.snapToNetwork(endLat, endLng, mode);

    if (!startSnap || !endSnap) return null;

    // Special case: Both points project onto the exact same road segment
    if (startSnap.seg && endSnap.seg && startSnap.seg === endSnap.seg) {
      const roadPath = [
        [startSnap.lat, startSnap.lng],
        [endSnap.lat, endSnap.lng]
      ];
      const dStart = this.haversineDistance(startLat, startLng, startSnap.lat, startSnap.lng);
      const dEnd = this.haversineDistance(endSnap.lat, endSnap.lng, endLat, endLng);
      const startConnector = dStart > 5 ? [[startLat, startLng], [startSnap.lat, startSnap.lng]] : null;
      const endConnector = dEnd > 5 ? [[endSnap.lat, endSnap.lng], [endLat, endLng]] : null;

      const pathCoords = [
        ...(startConnector ? [[startLat, startLng]] : []),
        ...roadPath,
        ...(endConnector ? [[endLat, endLng]] : [])
      ];

      return {
        path: pathCoords,
        roadPath,
        startConnector,
        endConnector,
        startJunction: startConnector ? [startSnap.lat, startSnap.lng] : null,
        endJunction: endConnector ? [endSnap.lat, endSnap.lng] : null
      };
    }

    // Insert temporary virtual start and end nodes into graph
    const tempStartId = `__start_${Date.now()}`;
    const tempEndId = `__end_${Date.now()}`;

    const tempStartNode = {
      id: tempStartId,
      lat: startSnap.lat,
      lng: startSnap.lng,
      neighbors: []
    };

    const tempEndNode = {
      id: tempEndId,
      lat: endSnap.lat,
      lng: endSnap.lng,
      neighbors: []
    };

    this.nodes.set(tempStartId, tempStartNode);
    this.nodes.set(tempEndId, tempEndNode);

    // Connect start to segment endpoints
    if (startSnap.seg) {
      const seg = startSnap.seg;
      const d1 = this.haversineDistance(startSnap.lat, startSnap.lng, seg.p1[0], seg.p1[1]);
      const d2 = this.haversineDistance(startSnap.lat, startSnap.lng, seg.p2[0], seg.p2[1]);

      tempStartNode.neighbors.push({
        id: seg.id1,
        dist: d1,
        highway: seg.highway,
        isFoot: seg.isFoot,
        isVeh: seg.isVeh,
        isOneway: false
      });
      tempStartNode.neighbors.push({
        id: seg.id2,
        dist: d2,
        highway: seg.highway,
        isFoot: seg.isFoot,
        isVeh: seg.isVeh,
        isOneway: false
      });
    } else {
      tempStartNode.neighbors.push({
        id: startSnap.nearestNodeId,
        dist: startSnap.dist,
        highway: 'connect',
        isFoot: true,
        isVeh: true,
        isOneway: false
      });
    }

    // Connect segment endpoints to end node
    if (endSnap.seg) {
      const seg = endSnap.seg;
      const d1 = this.haversineDistance(endSnap.lat, endSnap.lng, seg.p1[0], seg.p1[1]);
      const d2 = this.haversineDistance(endSnap.lat, endSnap.lng, seg.p2[0], seg.p2[1]);

      const n1 = this.nodes.get(seg.id1);
      const n2 = this.nodes.get(seg.id2);
      if (n1) n1.neighbors.push({ id: tempEndId, dist: d1, highway: seg.highway, isFoot: seg.isFoot, isVeh: seg.isVeh, isOneway: false, isTemp: true });
      if (n2) n2.neighbors.push({ id: tempEndId, dist: d2, highway: seg.highway, isFoot: seg.isFoot, isVeh: seg.isVeh, isOneway: false, isTemp: true });
    } else {
      const n = this.nodes.get(endSnap.nearestNodeId);
      if (n) n.neighbors.push({ id: tempEndId, dist: endSnap.dist, highway: 'connect', isFoot: true, isVeh: true, isOneway: false, isTemp: true });
    }

    // A* Shortest Path Search
    const openSet = new Set([tempStartId]);
    const cameFrom = new Map();
    const gScore = new Map();
    gScore.set(tempStartId, 0);

    const fScore = new Map();
    fScore.set(tempStartId, this.haversineDistance(startSnap.lat, startSnap.lng, endSnap.lat, endSnap.lng));

    let pathFound = false;

    while (openSet.size > 0) {
      let current = null;
      let lowestF = Infinity;
      for (const id of openSet) {
        const f = fScore.has(id) ? fScore.get(id) : Infinity;
        if (f < lowestF) {
          lowestF = f;
          current = id;
        }
      }

      if (current === tempEndId) {
        pathFound = true;
        break;
      }

      openSet.delete(current);
      const currG = gScore.get(current);
      const currNode = this.nodes.get(current);
      if (!currNode) continue;

      for (const neighbor of currNode.neighbors) {
        const edgeCost = this.getEdgeCost(neighbor, mode);
        if (!isFinite(edgeCost)) continue;

        const tentativeG = currG + edgeCost;
        const neighborG = gScore.has(neighbor.id) ? gScore.get(neighbor.id) : Infinity;

        if (tentativeG < neighborG) {
          cameFrom.set(neighbor.id, current);
          gScore.set(neighbor.id, tentativeG);
          const nObj = this.nodes.get(neighbor.id);
          if (nObj) {
            const h = this.haversineDistance(nObj.lat, nObj.lng, endSnap.lat, endSnap.lng);
            fScore.set(neighbor.id, tentativeG + h);
            openSet.add(neighbor.id);
          }
        }
      }
    }

    // Clean up temporary graph nodes
    this.nodes.delete(tempStartId);
    this.nodes.delete(tempEndId);
    if (endSnap.seg) {
      const n1 = this.nodes.get(endSnap.seg.id1);
      const n2 = this.nodes.get(endSnap.seg.id2);
      if (n1) n1.neighbors = n1.neighbors.filter(e => !e.isTemp);
      if (n2) n2.neighbors = n2.neighbors.filter(e => !e.isTemp);
    } else {
      const n = this.nodes.get(endSnap.nearestNodeId);
      if (n) n.neighbors = n.neighbors.filter(e => !e.isTemp);
    }

    if (!pathFound) {
      const fallbackPath = [[startLat, startLng], [(startLat + endLat) / 2, (startLng + endLng) / 2], [endLat, endLng]];
      return {
        path: fallbackPath,
        roadPath: fallbackPath,
        startConnector: null,
        endConnector: null,
        startJunction: null,
        endJunction: null
      };
    }

    // Reconstruct road path
    const rawRoadPath = [];
    let curr = tempEndId;
    while (curr) {
      if (curr === tempEndId) {
        rawRoadPath.unshift([endSnap.lat, endSnap.lng]);
      } else if (curr === tempStartId) {
        rawRoadPath.unshift([startSnap.lat, startSnap.lng]);
      } else {
        const n = this.nodes.get(curr);
        if (n) rawRoadPath.unshift([n.lat, n.lng]);
      }
      curr = cameFrom.get(curr);
    }

    // Deduplicate consecutive identical points
    const cleanRoadPath = [];
    for (let i = 0; i < rawRoadPath.length; i++) {
      if (cleanRoadPath.length === 0) {
        cleanRoadPath.push(rawRoadPath[i]);
      } else {
        const prev = cleanRoadPath[cleanRoadPath.length - 1];
        const d = this.haversineDistance(prev[0], prev[1], rawRoadPath[i][0], rawRoadPath[i][1]);
        if (d > 0.3) {
          cleanRoadPath.push(rawRoadPath[i]);
        }
      }
    }

    const dStart = this.haversineDistance(startLat, startLng, startSnap.lat, startSnap.lng);
    const dEnd = this.haversineDistance(endSnap.lat, endSnap.lng, endLat, endLng);

    const startConnector = dStart > 5 ? [[startLat, startLng], [startSnap.lat, startSnap.lng]] : null;
    const endConnector = dEnd > 5 ? [[endSnap.lat, endSnap.lng], [endLat, endLng]] : null;

    const pathCoords = [
      ...(startConnector ? [[startLat, startLng]] : []),
      ...cleanRoadPath,
      ...(endConnector ? [[endLat, endLng]] : [])
    ];

    return {
      path: pathCoords,
      roadPath: cleanRoadPath.length >= 2 ? cleanRoadPath : pathCoords,
      startConnector,
      endConnector,
      startJunction: startConnector ? [startSnap.lat, startSnap.lng] : null,
      endJunction: endConnector ? [endSnap.lat, endSnap.lng] : null
    };
  }

  buildGraphFromGeoJson(roadsGeoJson, footpathsGeoJson) {
    const roadData = [];
    const extractWays = (collection) => {
      if (!collection || !Array.isArray(collection.features)) return;
      collection.features.forEach(feature => {
        const coords = (feature.geometry && feature.geometry.coordinates) ? feature.geometry.coordinates : [];
        if (!Array.isArray(coords) || coords.length < 2) return;
        const props = feature.properties || {};
        roadData.push({
          id: feature.id !== undefined ? feature.id : (props.id !== undefined ? props.id : Math.random()),
          tags: {
            highway: props.highway || 'road',
            name: props.name || '',
            oneway: props.oneway || '',
            junction: props.junction || ''
          },
          coords: coords.map(([lng, lat]) => [lat, lng]),
          areaGeometry: props.area_geometry || null
        });
      });
    };
    extractWays(roadsGeoJson);
    extractWays(footpathsGeoJson);
    if (typeof window !== "undefined") {
      window.CAMPUS_ROADS_DATA = roadData;
    }
    this.initialized = false;
    this.buildGraph(roadData);
    return roadData;
  }
}

/* ============================================================================
   Directions Controller Class
   ============================================================================ */
class DirectionsController {
  constructor() {
    this.currentMode = "walking";
    this.currentOrigin = "Your location";
    this.currentDestination = "";
    this.currentStops = [];
    this.cloudAlertTimer = null;
    this.debounceTimer = null;
    this.activeRequestId = 0;
    this.roadGraph = new CampusRoadGraph();
  }

  async ensureGraphLoaded() {
    if (this.roadGraph && this.roadGraph.initialized && this.roadGraph.nodes && this.roadGraph.nodes.size > 0) {
      return;
    }
    if (typeof window !== "undefined" && window.CampusMap && window.CampusMap.geoJsonData &&
        window.CampusMap.geoJsonData.roads && window.CampusMap.geoJsonData.footpaths) {
      this.roadGraph.buildGraphFromGeoJson(window.CampusMap.geoJsonData.roads, window.CampusMap.geoJsonData.footpaths);
      return;
    }
    if (typeof fetch !== "undefined") {
      try {
        const [roadsRes, footpathsRes] = await Promise.all([
          fetch("geoJson/roads.geojson", { cache: "no-store" }),
          fetch("geoJson/footpath.geojson", { cache: "no-store" })
        ]);
        if (roadsRes.ok && footpathsRes.ok) {
          const [roadsData, footpathsData] = await Promise.all([roadsRes.json(), footpathsRes.json()]);
          this.roadGraph.buildGraphFromGeoJson(roadsData, footpathsData);
        }
      } catch (err) {
        console.warn("Directions could not auto-fetch GeoJSON networks:", err);
      }
    }
  }

  init() {
    this.roadGraph.buildGraph();
    this.bindEvents();
    this.setupAutocomplete();
    this.ensureGraphLoaded();
  }

  /* ==========================================================================
     📍 Geocoding Engine
     ========================================================================== */
  async geocodePlace(name) {
    if (!name || typeof name !== "string") {
      return { lat: CAMPUS_CENTER[0], lon: CAMPUS_CENTER[1], display: "Your location" };
    }

    const cleanName = name.trim().toLowerCase();

    // 1. Current GPS Location
    if (cleanName.includes("my location") || cleanName.includes("current location") || cleanName.includes("you are here") || cleanName.includes("your location")) {
      if (window.CampusMap && window.CampusMap.currentUserCoords) {
        return {
          lat: window.CampusMap.currentUserCoords[0],
          lon: window.CampusMap.currentUserCoords[1],
          display: "Your location"
        };
      }
      return { lat: CAMPUS_CENTER[0], lon: CAMPUS_CENTER[1], display: "Your location" };
    }

    // 2. Search Local Campus Locations
    const allLocs = (typeof getAllCampusLocations === "function") ? getAllCampusLocations() : (CAMPUS_LOCATIONS || []);
    
    // Direct / ID / Location Notation / UID Match
    const exact = allLocs.find(l => 
      l.name.toLowerCase() === cleanName ||
      l.id.toLowerCase() === cleanName ||
      (l.location_notation && l.location_notation.toLowerCase() === cleanName) ||
      (l.uid && String(l.uid).toLowerCase() === cleanName)
    );
    if (exact) return { lat: exact.lat, lon: exact.lng, display: exact.name };

    // Number extraction match (e.g. "25", "34", "31", "block 25")
    const numMatch = cleanName.match(/\b(\d{1,2})\b/);
    if (numMatch) {
      const num = numMatch[1];
      const blockMatch = allLocs.find(l => 
        l.id === `block-${num}` || 
        l.id.includes(`block-${num}`) || 
        l.name.toLowerCase() === `block ${num}` ||
        l.name.toLowerCase().includes(`block ${num}`) ||
        (l.tags && l.tags.some(t => t.toLowerCase() === `b${num}` || t.toLowerCase() === `block ${num}`))
      );
      if (blockMatch) return { lat: blockMatch.lat, lon: blockMatch.lng, display: blockMatch.name };
    }

    // Partial / Tag Match
    const partial = allLocs.find(l =>
      l.name.toLowerCase().includes(cleanName) ||
      l.id.toLowerCase().includes(cleanName) ||
      (l.tags && l.tags.some(t => t.toLowerCase().includes(cleanName)))
    );
    if (partial) return { lat: partial.lat, lon: partial.lng, display: partial.name };

    // 3. Search Campus Groups
    if (typeof CAMPUS_GROUPS !== "undefined" && Array.isArray(CAMPUS_GROUPS)) {
      const group = CAMPUS_GROUPS.find(g =>
        g.name.toLowerCase().includes(cleanName) ||
        g.id.toLowerCase().includes(cleanName) ||
        (g.tags && g.tags.some(t => t.toLowerCase().includes(cleanName)))
      );
      if (group && group.centerCoords) {
        return { lat: group.centerCoords[0], lon: group.centerCoords[1], display: group.name };
      }
    }

    // 4. Online Nominatim OpenStreetMap Geocoding
    try {
      const query = encodeURIComponent(`${name}, Lovely Professional University, Phagwara, Punjab`);
      const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;
      const response = await fetch(url, {
        headers: { 'Accept-Language': 'en', 'User-Agent': 'LPUMap/1.0' },
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) {
        const data = await response.json();
        if (data && data.length > 0) {
          const lat = parseFloat(data[0].lat);
          const lon = parseFloat(data[0].lon);
          return { lat, lon, display: data[0].display_name.split(',')[0] || name };
        }
      }
    } catch (e) {
      // Fall through to campus center
    }

    return { lat: CAMPUS_CENTER[0], lon: CAMPUS_CENTER[1], display: name };
  }

  /* ==========================================================================
     🛣️ Route Calculation Engine
     ========================================================================== */
  async fetchRoute(start, end, mode = "walking") {
    await this.ensureGraphLoaded();
    // 1. Calculate mode-aware route (footpaths for walking, vehicle roads for kart/cars)
    const rawResult = this.roadGraph.findPath(start.lat, start.lon, end.lat, end.lon, mode);

    let pathCoords = null;
    let roadPathCoords = null;
    let startConnector = null;
    let endConnector = null;
    let startJunction = null;
    let endJunction = null;

    if (rawResult && Array.isArray(rawResult)) {
      pathCoords = rawResult;
      roadPathCoords = rawResult;
    } else if (rawResult && typeof rawResult === "object") {
      pathCoords = rawResult.path;
      roadPathCoords = rawResult.roadPath;
      startConnector = rawResult.startConnector;
      endConnector = rawResult.endConnector;
      startJunction = rawResult.startJunction;
      endJunction = rawResult.endJunction;
    }

    const effectivePath = pathCoords || [[start.lat, start.lon], [end.lat, end.lon]];
    const effectiveRoadPath = roadPathCoords || effectivePath;

    // Calculate total path distance
    let totalDist = 0;
    if (effectivePath && effectivePath.length >= 2) {
      for (let i = 0; i < effectivePath.length - 1; i++) {
        totalDist += this.roadGraph.haversineDistance(
          effectivePath[i][0], effectivePath[i][1],
          effectivePath[i + 1][0], effectivePath[i + 1][1]
        );
      }
    } else {
      totalDist = this.roadGraph.haversineDistance(start.lat, start.lon, end.lat, end.lon) * 1.25;
    }

    const distMeters = Math.max(50, Math.round(totalDist));
    let speedMpm = 75; // walking default
    if (mode === "drive") speedMpm = 250;
    else if (mode === "moto") speedMpm = 230;
    else if (mode === "kart" || mode === "bicycle") speedMpm = 200;

    const durationMin = Math.max(1, Math.round(distMeters / speedMpm));

    // Generate smart turn steps along the path
    const steps = this.generateTurnSteps(start, end, effectivePath, distMeters, mode);

    return {
      path: effectivePath,
      roadPath: effectiveRoadPath,
      startConnector,
      endConnector,
      startJunction,
      endJunction,
      steps,
      distance: `${distMeters} m`,
      duration: `${durationMin} min`,
      distMeters,
      durationMin
    };
  }

  generateTurnSteps(start, end, path, totalDist, mode = "walking") {
    if (!Array.isArray(path) || path.length < 2) {
      return [
        { instruction: `Start from ${start.display}`, distance: "0 m", icon: "map-pin" },
        { instruction: `Arrive at ${end.display}`, distance: "0 m", icon: "map-pin", isArrival: true }
      ];
    }

    const steps = [];
    steps.push({
      instruction: `Start from ${start.display}`,
      distance: "0 m",
      icon: "map-pin"
    });

    const calculateBearing = (p1, p2) => {
      const lat1 = p1[0] * Math.PI / 180;
      const lat2 = p2[0] * Math.PI / 180;
      const dLon = (p2[1] - p1[1]) * Math.PI / 180;
      const y = Math.sin(dLon) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    };

    let accumulatedDist = 0;
    let lastBearing = null;
    let pendingInstruction = null;
    let pendingIcon = "navigation";

    // Sample along path to detect significant turns (> 35 deg) or curved sections
    for (let i = 0; i < path.length - 1; i++) {
      const p1 = path[i];
      const p2 = path[i + 1];
      const segDist = this.roadGraph.haversineDistance(p1[0], p1[1], p2[0], p2[1]);
      accumulatedDist += segDist;

      if (segDist < 1.0) continue;
      const currentBearing = calculateBearing(p1, p2);

      if (lastBearing !== null) {
        let diff = currentBearing - lastBearing;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;

        // Detect sharp turns or significant curves
        if (Math.abs(diff) >= 38) {
          const isRight = diff > 0;
          const turnDesc = isRight ? "Turn right onto campus road/pathway" : "Turn left onto campus road/pathway";
          const icon = isRight ? "corner-up-right" : "corner-up-left";

          if (accumulatedDist >= 25) {
            steps.push({
              instruction: pendingInstruction || (mode === "walking" ? "Follow walkway & pedestrian path" : "Follow campus vehicle road"),
              distance: `${Math.round(accumulatedDist)} m`,
              icon: pendingIcon
            });
            accumulatedDist = 0;
            pendingInstruction = turnDesc;
            pendingIcon = icon;
          }
        } else if (Math.abs(diff) >= 20 && Math.abs(diff) < 38) {
          // Moderate curve along path
          if (accumulatedDist >= 50 && !pendingInstruction) {
            pendingInstruction = diff > 0 ? "Follow curve to the right" : "Follow curve to the left";
            pendingIcon = diff > 0 ? "corner-up-right" : "corner-up-left";
          }
        }
      }
      lastBearing = currentBearing;
    }

    if (accumulatedDist > 0) {
      steps.push({
        instruction: pendingInstruction || (mode === "walking" ? "Continue toward destination" : "Drive toward destination"),
        distance: `${Math.round(accumulatedDist)} m`,
        icon: pendingIcon
      });
    }

    // Ensure we don't have too few steps
    if (steps.length <= 1) {
      steps.push({
        instruction: mode === "walking" ? "Follow campus walkway & pedestrian footpath" : "Follow campus vehicle road",
        distance: `${Math.round(totalDist)} m`,
        icon: "corner-up-right"
      });
    }

    steps.push({
      instruction: `Arrive at ${end.display}`,
      distance: "0 m",
      icon: "map-pin",
      isArrival: true
    });

    return steps;
  }

  /* ==========================================================================
     🎯 Autocomplete Setup
     ========================================================================== */
  setupAutocomplete() {
    const originInput = document.getElementById("direction-origin-input");
    const destInput = document.getElementById("direction-dest-input");
    const topOriginInput = document.getElementById("gmaps-topbar-origin-input");
    const topDestInput = document.getElementById("gmaps-topbar-dest-input");
    const topStopInput = document.getElementById("gmaps-topbar-stop-input");

    if (originInput) this.attachAutocomplete(originInput, "origin");
    if (destInput) this.attachAutocomplete(destInput, "dest");
    if (topOriginInput) this.attachAutocomplete(topOriginInput, "top-origin");
    if (topDestInput) this.attachAutocomplete(topDestInput, "top-dest");
    if (topStopInput) this.attachAutocomplete(topStopInput, "top-stop");

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".directions-inputs-card") && !e.target.closest(".gmaps-topbar-card")) {
        this.closeAllAutocompleteDropdowns();
      }
    });
  }

  attachAutocomplete(inputEl, type) {
    const wrapper = inputEl.parentElement;
    if (!wrapper) return;
    wrapper.style.position = "relative";

    let dropdown = wrapper.querySelector(".gmaps-autocomplete-dropdown") || wrapper.querySelector(".directions-autocomplete-dropdown");
    if (!dropdown) {
      dropdown = document.createElement("div");
      dropdown.className = "directions-autocomplete-dropdown";
      wrapper.appendChild(dropdown);
    }

    const renderSuggestions = (query) => {
      const q = (query || "").trim().toLowerCase();
      dropdown.innerHTML = "";

      // Bug 2: Only show suggestions when at least one character is typed
      if (q.length === 0) {
        dropdown.classList.remove("open");
        return;
      }

      const allLocs = (typeof getAllCampusLocations === "function") ? getAllCampusLocations() : (CAMPUS_LOCATIONS || []);
      const suggestions = [];

      // Always offer "Your location" for origin
      if ((type === "origin" || type === "top-origin") && ("your location".includes(q) || "my location".includes(q) || "current location".includes(q))) {
        suggestions.push({
          name: "Your location",
          sub: "Live GPS on campus",
          type: "gps"
        });
      }

      // Filter matching campus locations
      allLocs.forEach(loc => {
        const matchesName = loc.name.toLowerCase().includes(q);
        const matchesType = (loc.type || "").toLowerCase().includes(q);
        const matchesTag = loc.tags && loc.tags.some(t => t.toLowerCase().includes(q));
        if (matchesName || matchesType || matchesTag) {
          suggestions.push({
            name: loc.name,
            sub: loc.type || loc.groupName || "Campus Location",
            type: "place"
          });
        }
      });

      if (typeof CAMPUS_GROUPS !== "undefined" && Array.isArray(CAMPUS_GROUPS)) {
        CAMPUS_GROUPS.forEach(grp => {
          if (grp.name.toLowerCase().includes(q)) {
            suggestions.push({
              name: grp.name,
              sub: "Academic School / Department",
              type: "group"
            });
          }
        });
      }

      if (suggestions.length === 0) {
        dropdown.innerHTML = `<div class="auto-item-empty">No campus location matched "${query}"</div>`;
        dropdown.classList.add("open");
        return;
      }

      suggestions.slice(0, 8).forEach(item => {
        const itemEl = document.createElement("div");
        itemEl.className = "directions-auto-item";
        itemEl.innerHTML = `
          <div class="auto-item-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
              <circle cx="12" cy="10" r="3"></circle>
            </svg>
          </div>
          <div class="auto-item-info">
            <div class="auto-item-title">${item.name}</div>
            <div class="auto-item-sub">${item.sub}</div>
          </div>
        `;

        const selectItem = (e) => {
          if (e) {
            e.preventDefault();
            e.stopPropagation();
          }
          clearTimeout(this.debounceTimer);
          inputEl.value = item.name;
          if (type === "origin" || type === "top-origin") {
            this.currentOrigin = item.name;
            this.updateStartNavigationVisibility(item.name);
            const topO = document.getElementById("gmaps-topbar-origin-input");
            const panO = document.getElementById("direction-origin-input");
            if (topO) topO.value = item.name;
            if (panO) panO.value = item.name;
            if (type === "top-origin" && this.currentDestination) {
              this.showDirections(this.currentOrigin, this.currentDestination);
            }
          }
          if (type === "dest" || type === "top-dest") {
            this.currentDestination = item.name;
            const topD = document.getElementById("gmaps-topbar-dest-input");
            const panD = document.getElementById("direction-dest-input");
            if (topD) topD.value = item.name;
            if (panD) panD.value = item.name;
            this.updateDestinationState(item.name);
            if (type === "top-dest" && this.currentDestination) {
              this.showDirections(this.currentOrigin, this.currentDestination);
            }
          }
          if (type.startsWith("top-stop") || type.startsWith("panel-stop")) {
            const idxMatch = type.match(/\d+$/);
            const idx = idxMatch ? parseInt(idxMatch[0], 10) : 0;
            this.currentStops[idx] = item.name;
            inputEl.value = item.name;
            const topInput = document.getElementById(`gmaps-topbar-stop-input-${idx}`);
            const panInput = document.getElementById(`direction-panel-stop-input-${idx}`);
            if (topInput) topInput.value = item.name;
            if (panInput) panInput.value = item.name;
            if (this.currentDestination) {
              this.showDirections(this.currentOrigin, this.currentDestination);
            }
          }
          dropdown.classList.remove("open");
        };

        let touchStartY = 0;
        let touchStartX = 0;
        let isTouchScroll = false;
        let touchHandled = false;

        itemEl.addEventListener("touchstart", (e) => {
          if (e.touches && e.touches[0]) {
            touchStartY = e.touches[0].clientY;
            touchStartX = e.touches[0].clientX;
            isTouchScroll = false;
            touchHandled = false;
          }
        }, { passive: true });

        itemEl.addEventListener("touchmove", (e) => {
          if (e.touches && e.touches[0]) {
            const dy = Math.abs(e.touches[0].clientY - touchStartY);
            const dx = Math.abs(e.touches[0].clientX - touchStartX);
            if (dy > 6 || dx > 6) {
              isTouchScroll = true;
            }
          }
        }, { passive: true });

        itemEl.addEventListener("touchend", (e) => {
          if (isTouchScroll) return;
          touchHandled = true;
          selectItem(e);
        });

        itemEl.addEventListener("click", (e) => {
          if (isTouchScroll) {
            isTouchScroll = false;
            return;
          }
          if (touchHandled) {
            touchHandled = false;
            return;
          }
          selectItem(e);
        });

        itemEl.addEventListener("mousedown", (e) => {
          e.preventDefault();
        });

        dropdown.appendChild(itemEl);
      });

      dropdown.classList.add("open");
    };

    inputEl.addEventListener("focus", () => {
      const val = (inputEl.value || "").trim();
      // Bug 2: Do not show suggestions when focusing an empty input
      if (val.length > 0) {
        renderSuggestions(inputEl.value);
      } else {
        dropdown.innerHTML = "";
        dropdown.classList.remove("open");
      }
    });

    inputEl.addEventListener("input", () => {
      const val = (inputEl.value || "").trim();
      if (type === "origin" || type === "top-origin") {
        this.updateStartNavigationVisibility(inputEl.value);
      }
      if (type === "dest" || type === "top-dest") {
        this.currentDestination = inputEl.value;
        this.updateDestinationState(inputEl.value);
      }
      if (type.startsWith("top-stop") || type.startsWith("panel-stop")) {
        const idxMatch = type.match(/\d+$/);
        const idx = idxMatch ? parseInt(idxMatch[0], 10) : 0;
        this.currentStops[idx] = inputEl.value;
      }
      // Bug 2: Only show suggestions when input contains at least one character, hide if empty
      if (val.length > 0) {
        renderSuggestions(inputEl.value);
      } else {
        dropdown.innerHTML = "";
        dropdown.classList.remove("open");
      }
    });

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(this.debounceTimer);
        dropdown.classList.remove("open");
        if (type === "origin" || type === "top-origin") {
          this.currentOrigin = inputEl.value;
          this.updateStartNavigationVisibility(inputEl.value);
          const topO = document.getElementById("gmaps-topbar-origin-input");
          const panO = document.getElementById("direction-origin-input");
          if (topO) topO.value = inputEl.value;
          if (panO) panO.value = inputEl.value;
          if (type === "top-origin" && this.currentDestination) {
            this.showDirections(this.currentOrigin, this.currentDestination);
          }
        }
        if (type === "dest" || type === "top-dest") {
          this.currentDestination = inputEl.value;
          const topD = document.getElementById("gmaps-topbar-dest-input");
          const panD = document.getElementById("direction-dest-input");
          if (topD) topD.value = inputEl.value;
          if (panD) panD.value = inputEl.value;
          this.updateDestinationState(inputEl.value);
          if (type === "top-dest" && this.currentDestination) {
            this.showDirections(this.currentOrigin, this.currentDestination);
          }
        }
        if (type.startsWith("top-stop") || type.startsWith("panel-stop")) {
          const idxMatch = type.match(/\d+$/);
          const idx = idxMatch ? parseInt(idxMatch[0], 10) : 0;
          this.currentStops[idx] = inputEl.value;
          if (this.currentDestination) {
            this.showDirections(this.currentOrigin, this.currentDestination);
          }
        }
      }
    });
  }

  closeAllAutocompleteDropdowns() {
    document.querySelectorAll(".directions-autocomplete-dropdown, .gmaps-autocomplete-dropdown").forEach(d => {
      d.classList.remove("open");
    });
  }

  showCloudAlert(msg = "You can add up to 3 stops") {
    const alertEl = document.getElementById("gmaps-add-stop-cloud-alert");
    if (!alertEl) return;
    const bodyEl = alertEl.querySelector(".cloud-alert-body");
    if (bodyEl) bodyEl.textContent = msg;

    alertEl.style.display = "block";
    clearTimeout(this.cloudAlertTimer);
    this.cloudAlertTimer = setTimeout(() => {
      alertEl.style.display = "none";
    }, 3000);
  }

  renderStopInputs() {
    // 1. Google Maps Topbar Stops Container
    const topbarContainer = document.getElementById("gmaps-topbar-stops-container");
    if (topbarContainer) {
      topbarContainer.innerHTML = "";
      this.currentStops.forEach((stopVal, index) => {
        const stopNum = index + 1;
        const itemEl = document.createElement("div");
        itemEl.className = "gmaps-stop-item";
        itemEl.dataset.index = index;
        itemEl.innerHTML = `
          <div class="gmaps-topbar-connector">
            <div class="gmaps-connector-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
          <div class="gmaps-topbar-row gmaps-topbar-stop-row">
            <div class="gmaps-topbar-indicator">
              <div class="gmaps-dot-stop">${stopNum}</div>
            </div>
            <div class="gmaps-topbar-input-wrap">
              <input id="gmaps-topbar-stop-input-${index}" class="gmaps-topbar-input gmaps-stop-input" type="search" value="${stopVal || ""}" placeholder="Add stop ${stopNum}..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
              <div id="gmaps-topbar-stop-dropdown-${index}" class="gmaps-autocomplete-dropdown"></div>
            </div>
            <button class="gmaps-topbar-icon-btn gmaps-stop-remove-btn" data-index="${index}" title="Remove stop ${stopNum}" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        `;

        const removeBtn = itemEl.querySelector(".gmaps-stop-remove-btn");
        if (removeBtn) {
          removeBtn.addEventListener("click", (e) => {
            if (e) {
              e.preventDefault();
              e.stopPropagation();
            }
            this.currentStops.splice(index, 1);
            this.renderStopInputs();
            if (this.currentDestination) {
              this.showDirections(this.currentOrigin, this.currentDestination);
            }
          });
        }

        const inputEl = itemEl.querySelector(".gmaps-stop-input");
        if (inputEl) {
          this.attachAutocomplete(inputEl, `top-stop-${index}`);
        }

        topbarContainer.appendChild(itemEl);
      });
    }

    // 2. Directions Panel Drawer Stops Container
    const drawerContainer = document.getElementById("direction-panel-stops-container");
    if (drawerContainer) {
      drawerContainer.innerHTML = "";
      this.currentStops.forEach((stopVal, index) => {
        const stopNum = index + 1;
        const itemEl = document.createElement("div");
        itemEl.className = "direction-panel-stop-row";
        itemEl.dataset.index = index;
        itemEl.innerHTML = `
          <span class="direction-panel-stop-dot" title="Stop ${stopNum}">${stopNum}</span>
          <div class="direction-panel-stop-input-wrap">
            <input id="direction-panel-stop-input-${index}" class="input-location-field direction-panel-stop-input" type="search" value="${stopVal || ""}" placeholder="Stop ${stopNum} (e.g. Block 27)" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" />
          </div>
          <button class="direction-panel-stop-remove-btn" data-index="${index}" title="Remove stop ${stopNum}" type="button">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        `;

        const removeBtn = itemEl.querySelector(".direction-panel-stop-remove-btn");
        if (removeBtn) {
          removeBtn.addEventListener("click", (e) => {
            if (e) {
              e.preventDefault();
              e.stopPropagation();
            }
            this.currentStops.splice(index, 1);
            this.renderStopInputs();
            if (this.currentDestination) {
              this.showDirections(this.currentOrigin, this.currentDestination);
            }
          });
        }

        const inputEl = itemEl.querySelector(".direction-panel-stop-input");
        if (inputEl) {
          this.attachAutocomplete(inputEl, `panel-stop-${index}`);
        }

        drawerContainer.appendChild(itemEl);
      });
    }
  }

  /* ==========================================================================
     🎛️ Event Handlers
     ========================================================================== */
  bindEvents() {
    // Mode tab buttons (panel)
    const modeTabs = document.querySelectorAll(".mode-tab-btn");
    modeTabs.forEach(tab => {
      tab.addEventListener("click", (e) => {
        if (e) e.preventDefault();
        modeTabs.forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        this.currentMode = tab.dataset.mode || "walking";

        const originVal = this.currentOrigin || "Your location";
        const destVal = this.currentDestination;
        if (destVal) this.showDirections(originVal, destVal);
      });
    });

    // Google Maps Preview Mode Tabs (Only Car & Walk)
    const gmapsTabs = document.querySelectorAll(".gmaps-mode-tab");
    gmapsTabs.forEach(tab => {
      tab.addEventListener("click", (e) => {
        if (e) e.preventDefault();
        const selectedMode = tab.dataset.mode || "drive";
        console.log(`[LPUNavix] Mode tab clicked: ${selectedMode}`);
        if (this.currentMode === selectedMode) return;
        this.currentMode = selectedMode;

        gmapsTabs.forEach(t => t.classList.toggle("active", t === tab));

        const originVal = this.currentOrigin || "Your location";
        const destVal = this.currentDestination;
        if (destVal && destVal.trim() !== "") {
          this.showDirections(originVal, destVal);
        }
      });
    });

    // Swap locations buttons (both panel and floating topbar)
    const handleSwap = (e) => {
      if (e) e.preventDefault();
      clearTimeout(this.debounceTimer);
      const temp = this.currentOrigin || "Your location";
      this.currentOrigin = this.currentDestination || "Your location";
      this.currentDestination = temp === "Your location" ? "" : temp;
      this.updateStartNavigationVisibility(this.currentOrigin);

      const originInput = document.getElementById("direction-origin-input");
      const destInput = document.getElementById("direction-dest-input");
      const topOriginInput = document.getElementById("gmaps-topbar-origin-input");
      const topDestInput = document.getElementById("gmaps-topbar-dest-input");

      if (originInput) originInput.value = this.currentOrigin;
      if (destInput) destInput.value = this.currentDestination;
      if (topOriginInput) topOriginInput.value = this.currentOrigin;
      if (topDestInput) topDestInput.value = this.currentDestination;

      if (this.currentDestination && this.currentDestination.trim() !== "") {
        this.showDirections(this.currentOrigin, this.currentDestination);
      }
    };

    const swapBtn = document.getElementById("swap-directions-btn");
    if (swapBtn) swapBtn.addEventListener("click", handleSwap);

    const topSwapBtn = document.getElementById("gmaps-topbar-swap-btn");
    if (topSwapBtn) topSwapBtn.addEventListener("click", handleSwap);

    // Close / Cross ("✕") button on Google Maps Preview Sheet
    const closePreviewBtn = document.getElementById("gmaps-preview-close-btn");
    if (closePreviewBtn) {
      closePreviewBtn.addEventListener("click", (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        console.log("[LPUNavix] Close preview button clicked -> resetting route and map view");
        this.exitDirections();
      });
    }

    // Find Route button in drawer
    const findRouteBtn = document.getElementById("find-route-btn");
    if (findRouteBtn) {
      const handleFindRoute = (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        clearTimeout(this.debounceTimer);
        const originVal = document.getElementById("direction-origin-input")?.value || "Your location";
        const destVal = document.getElementById("direction-dest-input")?.value || this.currentDestination || "";
        if (destVal && destVal.trim() !== "") {
          this.showDirections(originVal, destVal);
        }
      };
      findRouteBtn.addEventListener("click", handleFindRoute);
    }

    // Start navigation buttons (both in drawer and Google Maps preview sheet)
    const handleStartNav = (e) => {
      if (e) e.preventDefault();
      if (!this.isMyLocationOrigin(this.currentOrigin)) return;
      console.log(`[LPUNavix] Start Navigation clicked for mode: ${this.currentMode}, destination: ${this.currentDestination}`);
      const dest = this.currentDestination || "Destination";
      const dur = (this.currentRouteData && this.currentRouteData.activeRoute) ? this.currentRouteData.activeRoute.duration : "1 min";
      const dist = (this.currentRouteData && this.currentRouteData.activeRoute) ? this.currentRouteData.activeRoute.distance : "230 m";
      const path = (this.currentRouteData && this.currentRouteData.activeRoute) ? this.currentRouteData.activeRoute.path : null;

      if (window.UIController) {
        window.UIController.startActiveNavigation(dest, dur, dist, this.currentMode, path);
      }
    };

    const startNavBtn = document.getElementById("start-nav-btn");
    if (startNavBtn) startNavBtn.addEventListener("click", handleStartNav);

    const gmapsStartBtn = document.getElementById("gmaps-start-action-btn");
    if (gmapsStartBtn) gmapsStartBtn.addEventListener("click", handleStartNav);

    // Share & Add stops buttons
    const handleShare = (e) => {
      if (e) e.preventDefault();
      console.log(`[LPUNavix] Share route clicked for: ${this.currentDestination}`);
      const originStr = this.currentOrigin || "Your location";
      const destStr = this.currentDestination || "Destination";
      const shareText = `Campus route from ${originStr} to ${destStr} on LPUNavix`;
      if (navigator.share) {
        navigator.share({
          title: `Route to ${destStr} - LPUNavix`,
          text: shareText,
          url: window.location.href
        }).catch(() => {});
      } else {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(window.location.href);
        }
        if (window.UIController && typeof window.UIController.showToast === "function") {
          window.UIController.showToast("Route link copied to clipboard!");
        } else {
          alert("Route link copied to clipboard!");
        }
      }
    };

    const shareTopBtn = document.getElementById("gmaps-preview-share-top-btn");
    const shareActBtn = document.getElementById("gmaps-share-action-btn");
    if (shareTopBtn) shareTopBtn.addEventListener("click", handleShare);
    if (shareActBtn) shareActBtn.addEventListener("click", handleShare);

    const addStopsBtn = document.getElementById("gmaps-add-stops-action-btn");
    if (addStopsBtn) {
      addStopsBtn.addEventListener("click", (e) => {
        if (e) e.preventDefault();
        console.log(`[LPUNavix] Add stops clicked. Current stops count: ${this.currentStops.length}`);
        if (this.currentStops.length >= 3) {
          this.showCloudAlert("You can add up to 3 stops");
          return;
        }

        this.currentStops.push("");
        this.renderStopInputs();

        // Focus newly created stop input
        const newIdx = this.currentStops.length - 1;
        const newInput = document.getElementById(`gmaps-topbar-stop-input-${newIdx}`);
        if (newInput) newInput.focus();
      });
    }

    const removeStopBtn = document.getElementById("gmaps-topbar-remove-stop-btn");
    if (removeStopBtn) {
      removeStopBtn.addEventListener("click", (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        this.currentStops = [];
        this.renderStopInputs();
        if (this.currentDestination) {
          this.showDirections(this.currentOrigin, this.currentDestination);
        }
      });
    }

    // 3-dot Menu dropdown on top route card
    const topMenuBtn = document.getElementById("gmaps-topbar-menu-btn");
    const topMenuDropdown = document.getElementById("gmaps-topbar-menu-dropdown");
    if (topMenuBtn && topMenuDropdown) {
      topMenuBtn.addEventListener("click", (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        const isShown = topMenuDropdown.style.display !== "none";
        topMenuDropdown.style.display = isShown ? "none" : "flex";
      });

      document.addEventListener("click", (e) => {
        if (!e.target.closest("#gmaps-topbar-menu-btn") && !e.target.closest("#gmaps-topbar-menu-dropdown")) {
          topMenuDropdown.style.display = "none";
        }
      });

      const optSwap = document.getElementById("menu-opt-swap");
      if (optSwap) {
        optSwap.addEventListener("click", (e) => {
          topMenuDropdown.style.display = "none";
          handleSwap(e);
        });
      }

      const optShare = document.getElementById("menu-opt-share");
      if (optShare) {
        optShare.addEventListener("click", (e) => {
          topMenuDropdown.style.display = "none";
          handleShare(e);
        });
      }

      const optClear = document.getElementById("menu-opt-clear");
      if (optClear) {
        optClear.addEventListener("click", (e) => {
          topMenuDropdown.style.display = "none";
          this.exitDirections();
        });
      }
    }

    const tuneBtn = document.getElementById("gmaps-preview-tune-btn");
    if (tuneBtn) {
      tuneBtn.addEventListener("click", (e) => {
        if (e) e.preventDefault();
        console.log("[LPUNavix] Route options / filter clicked");
      });
    }
  }

  /* ==========================================================================
     📍 Open Directions with Stop (Add to Route)
     Opens the directions topbar with Origin, intermediate stop(s), and blank destination
     ========================================================================== */
  openDirectionsWithStop(origin = "Your location", stopName = "", dest = "") {
    clearTimeout(this.debounceTimer);
    this.currentOrigin = origin || "Your location";
    this.currentDestination = dest || "";
    this.currentStops = stopName ? [stopName] : [];

    // 1. Close location slide if open
    if (window.UIController && typeof window.UIController.closeLocationDetails === "function") {
      window.UIController.closeLocationDetails();
    }

    // 2. Remove gmaps-route-active so the directions drawer panel is fully visible
    document.body.classList.remove("gmaps-route-active");
    const topbar = document.getElementById("gmaps-route-topbar");
    if (topbar) {
      topbar.style.display = "none";
    }
    this.hideRoutePreview();

    // 3. Clear active route on map if any
    if (window.CampusMap) {
      window.CampusMap.clearRoute();
    }

    // 4. Update input values in drawer and topbar
    const originInput = document.getElementById("direction-origin-input");
    const destInput = document.getElementById("direction-dest-input");
    const topOriginInput = document.getElementById("gmaps-topbar-origin-input");
    const topDestInput = document.getElementById("gmaps-topbar-dest-input");

    if (originInput) originInput.value = this.currentOrigin;
    if (destInput) destInput.value = this.currentDestination;
    if (topOriginInput) topOriginInput.value = this.currentOrigin;
    if (topDestInput) topDestInput.value = this.currentDestination;

    // 5. Render stops in both drawer and topbar containers
    this.renderStopInputs();

    // 6. Open Directions panel page drawer
    if (window.UIController) {
      window.UIController.openLeftPanel("directions-panel");
      document.querySelectorAll(".mobile-nav-item, .nav-item-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.view === "directions");
      });
      window.UIController.setNavState("directions", {
        origin: this.currentOrigin,
        stops: this.currentStops,
        dest: ""
      });
    }

    // 7. Auto-focus the destination input in the directions drawer
    setTimeout(() => {
      if (destInput) {
        destInput.focus();
      }
    }, 150);
  }

  /* ==========================================================================
     🚀 Main Function: showDirections(origin, destination)
     Calculates multi-modal routes, draws solid highlighted route on map with
     on-route ETA badge, and displays Google Maps-style route overview.
     ========================================================================== */
  async showDirections(origin = "Your location", dest = "", skipHistory = false) {
    clearTimeout(this.debounceTimer);
    const reqId = ++this.activeRequestId;

    if (!dest || dest.trim() === "") {
      this.currentDestination = "";
      if (window.CampusMap) window.CampusMap.clearRoute();
      this.hideRoutePreview();
      return;
    }

    this.currentOrigin = origin;
    this.currentDestination = dest;
    this.updateStartNavigationVisibility(origin);

    const originInput = document.getElementById("direction-origin-input");
    const destInput = document.getElementById("direction-dest-input");
    const topOriginInput = document.getElementById("gmaps-topbar-origin-input");
    const topDestInput = document.getElementById("gmaps-topbar-dest-input");
    if (originInput && originInput.value !== origin) originInput.value = origin;
    if (destInput && destInput.value !== dest) destInput.value = dest;
    if (topOriginInput && topOriginInput.value !== origin) topOriginInput.value = origin;
    if (topDestInput && topDestInput.value !== dest) topDestInput.value = dest;

    this.closeAllAutocompleteDropdowns();

    // Ensure history state is recorded so phone/browser back button returns to previous slide or map
    if (!skipHistory && window.UIController) {
      window.UIController.setNavState("route", {
        origin: this.currentOrigin,
        dest: this.currentDestination,
        mode: this.currentMode
      });
    }

    // Close the old panel drawer so user has full view of map and Google Maps sheet
    if (window.UIController) {
      window.UIController.closeLeftPanels();
    }

    try {
      const start = await this.geocodePlace(origin || "Your location");
      const end = await this.geocodePlace(dest);

      if (reqId !== this.activeRequestId) return;

      // Extract valid stops (up to 3)
      const validStops = (this.currentStops || []).filter(s => s && s.trim() !== "").slice(0, 3);
      const waypoints = [];
      for (let i = 0; i < validStops.length; i++) {
        const geo = await this.geocodePlace(validStops[i]);
        waypoints.push({ ...geo, stopIndex: i + 1, originalName: validStops[i] });
      }

      if (reqId !== this.activeRequestId) return;

      const targetPoints = [start, ...waypoints, end];

      const computeMultiLegRoute = async (mode) => {
        let fullPath = [];
        let roadPath = [];
        const connectors = [];
        const junctions = [];
        let totalDistMeters = 0;
        const steps = [];

        for (let i = 0; i < targetPoints.length - 1; i++) {
          const p1 = targetPoints[i];
          const p2 = targetPoints[i + 1];
          const leg = await this.fetchRoute(p1, p2, mode);

          if (leg) {
            totalDistMeters += leg.distMeters || 50;

            if (fullPath.length === 0) {
              fullPath = [...leg.path];
            } else {
              fullPath = [...fullPath, ...leg.path.slice(1)];
            }

            if (leg.roadPath && leg.roadPath.length > 0) {
              if (roadPath.length === 0) {
                roadPath = [...leg.roadPath];
              } else {
                roadPath = [...roadPath, ...leg.roadPath.slice(1)];
              }
            }

            const addConnector = (conn) => {
              if (!conn || conn.length < 2) return;
              const isDup = connectors.some(existing => {
                const same = Math.abs(existing[0][0] - conn[0][0]) < 1e-5 && Math.abs(existing[0][1] - conn[0][1]) < 1e-5 &&
                             Math.abs(existing[1][0] - conn[1][0]) < 1e-5 && Math.abs(existing[1][1] - conn[1][1]) < 1e-5;
                const rev = Math.abs(existing[0][0] - conn[1][0]) < 1e-5 && Math.abs(existing[0][1] - conn[1][1]) < 1e-5 &&
                            Math.abs(existing[1][0] - conn[0][0]) < 1e-5 && Math.abs(existing[1][1] - conn[0][1]) < 1e-5;
                return same || rev;
              });
              if (!isDup) connectors.push(conn);
            };

            const addJunction = (junc) => {
              if (!junc || junc.length < 2) return;
              const isDup = junctions.some(existing =>
                Math.abs(existing[0] - junc[0]) < 1e-5 && Math.abs(existing[1] - junc[1]) < 1e-5
              );
              if (!isDup) junctions.push(junc);
            };

            if (leg.startConnector) addConnector(leg.startConnector);
            if (leg.endConnector) addConnector(leg.endConnector);
            if (leg.startJunction) addJunction(leg.startJunction);
            if (leg.endJunction) addJunction(leg.endJunction);

            if (leg.steps) {
              if (i === 0) {
                steps.push(...leg.steps);
              } else {
                steps.push(...leg.steps.slice(1));
              }
            }
          }
        }

        const speedMpm = (mode === "drive" || mode === "kart") ? 220 : 75;
        const durationMin = Math.max(1, Math.round(totalDistMeters / speedMpm));
        const formattedDist = totalDistMeters >= 1000 
          ? `${(totalDistMeters / 1000).toFixed(1)} km` 
          : `${totalDistMeters} m`;

        return {
          path: fullPath,
          roadPath: roadPath.length >= 2 ? roadPath : fullPath,
          connectors,
          junctions,
          waypoints,
          steps,
          distance: formattedDist,
          duration: `${durationMin} min`,
          distMeters: totalDistMeters,
          durationMin
        };
      };

      const driveRoute = await computeMultiLegRoute("drive");
      const walkRoute = await computeMultiLegRoute("walking");

      if (reqId !== this.activeRequestId) return;

      const activeRoute = (this.currentMode === "walking") ? walkRoute : driveRoute;

      this.currentRouteData = {
        activeRoute,
        driveRoute,
        walkRoute,
        start,
        end,
        waypoints,
        mode: this.currentMode
      };

      // 2. Draw the dotted route on the campus map in preview mode.
      if (window.CampusMap) {
        window.CampusMap.drawRoute(activeRoute.path, false, null, {
          mode: this.currentMode,
          originName: start.display,
          destName: end.display,
          duration: activeRoute.duration,
          distance: activeRoute.distance,
          walkDuration: walkRoute.duration,
          walkDistance: walkRoute.distance,
          kartDuration: driveRoute.duration,
          kartDistance: driveRoute.distance,
          roadPath: activeRoute.roadPath,
          connectors: activeRoute.connectors,
          junctions: activeRoute.junctions,
          waypoints: activeRoute.waypoints,
          isNavigating: false,
          isDotted: true,
          alternateRoute: (this.currentMode === "walking" ? driveRoute : walkRoute)
        });
      }

      // 3. Reveal & Render Google Maps Style Route Preview Page
      this.renderGoogleMapsPreview(start, end, driveRoute, walkRoute, activeRoute);

    } catch (error) {
      console.error("Error calculating directions:", error);
    }
  }

  /* ==========================================================================
     📱 Google Maps Style Route Preview Render & Reset
     ========================================================================== */
  updateDestinationState(destName) {
    const hasDest = !!(destName && destName.trim().length > 0);
    const actionsRow = document.querySelector(".directions-actions-row");
    const quickChips = document.querySelector(".directions-quick-chips");

    if (actionsRow) actionsRow.style.display = hasDest ? "block" : "none";
    if (quickChips) quickChips.style.display = hasDest ? "none" : "flex";
  }

  isMyLocationOrigin(origin) {
    const normalized = String(origin || "").trim().toLowerCase().replace(/[^a-z]+/g, " ").trim();
    return ["your location", "my location", "current location", "your current location", "you are here"].includes(normalized);
  }

  updateStartNavigationVisibility(origin = this.currentOrigin) {
    const isMyLocation = this.isMyLocationOrigin(origin);
    ["start-nav-btn", "gmaps-start-action-btn"].forEach(id => {
      const button = document.getElementById(id);
      if (!button) return;
      button.hidden = !isMyLocation;
      button.style.setProperty("display", isMyLocation ? "" : "none", "important");
      button.setAttribute("aria-hidden", String(!isMyLocation));
    });
  }

  selectDestination(destName) {
    if (!destName) return;
    const originInput = document.getElementById("direction-origin-input");
    const destInput = document.getElementById("direction-dest-input");
    const topDestInput = document.getElementById("gmaps-topbar-dest-input");
    if (!originInput || !originInput.value || !originInput.value.trim()) {
      if (originInput) originInput.value = "Your location";
      this.currentOrigin = "Your location";
    }
    if (destInput) destInput.value = destName;
    if (topDestInput) topDestInput.value = destName;
    this.currentDestination = destName;
    this.updateDestinationState(destName);
  }

  renderGoogleMapsPreview(start, end, driveRoute, walkRoute, activeRoute) {
    document.body.classList.add("gmaps-route-active");
    // Ensure Directions tab is active in footer nav
    document.querySelectorAll(".mobile-nav-item").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === "directions");
    });
    const topBar = document.getElementById("gmaps-route-topbar");
    const previewSheet = document.getElementById("gmaps-route-preview-sheet");

    if (topBar) {
      const topOrigin = document.getElementById("gmaps-topbar-origin-input");
      const topDest = document.getElementById("gmaps-topbar-dest-input");

      if (topOrigin) topOrigin.value = (start && start.display) || this.currentOrigin || "Your location";
      if (topDest) topDest.value = (end && end.display) || this.currentDestination;

      this.renderStopInputs();

      topBar.style.display = "block";
    }

    if (previewSheet) {
      // Title
      const modeTitle = document.getElementById("gmaps-preview-mode-title");
      if (modeTitle) {
        modeTitle.textContent = (this.currentMode === "walking") ? "Walk" : "Kart";
      }

      // Mode Tab Times & Distances: Kart and Walk
      const driveTime = document.getElementById("gmaps-tab-drive-time");
      const walkTime = document.getElementById("gmaps-tab-walk-time");
      const driveDist = document.getElementById("gmaps-tab-drive-dist");
      const walkDist = document.getElementById("gmaps-tab-walk-dist");

      if (driveTime && driveRoute) driveTime.textContent = driveRoute.duration;
      if (walkTime && walkRoute) walkTime.textContent = walkRoute.duration;
      if (driveDist && driveRoute) driveDist.textContent = driveRoute.distance;
      if (walkDist && walkRoute) walkDist.textContent = walkRoute.distance;

      // Active Tab Highlight
      const modeTabs = previewSheet.querySelectorAll(".gmaps-mode-tab");
      modeTabs.forEach(t => {
        t.classList.toggle("active", t.dataset.mode === this.currentMode);
      });

      // Stats Summary Block
      const durationEl = document.getElementById("gmaps-preview-duration");
      const distEl = document.getElementById("gmaps-preview-dist");
      if (durationEl && activeRoute) durationEl.textContent = activeRoute.duration;
      if (distEl && activeRoute) distEl.textContent = `(${activeRoute.distance})`;

      const subtitleEl = previewSheet.querySelector(".gmaps-preview-subtitle");
      if (subtitleEl && driveRoute && walkRoute) {
        subtitleEl.textContent = `Fastest by Kart: ${driveRoute.duration} (${driveRoute.distance}) • Walk: ${walkRoute.duration} (${walkRoute.distance})`;
      }

      previewSheet.style.display = "block";

      requestAnimationFrame(() => {
        const controls = document.querySelector(".map-floating-controls");
        if (controls && previewSheet) {
          const sheetH = previewSheet.offsetHeight || 225;
          controls.style.setProperty("bottom", `calc(${sheetH + 14}px + env(safe-area-inset-bottom, 0px))`, "important");
        }
      });
    }
  }

  closeRouteAndReset() {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.cloudAlertTimer);
    this.currentMode = "walking";
    this.currentRouteData = null;
    this.currentStops = [];

    const container = document.getElementById("gmaps-topbar-stops-container");
    if (container) container.innerHTML = "";

    const alertEl = document.getElementById("gmaps-add-stop-cloud-alert");
    if (alertEl) alertEl.style.display = "none";

    // 1. Remove highlighted route polyline, waypoints, and ETA badge from map
    if (window.CampusMap) {
      if (typeof window.CampusMap.clearRoute === "function") window.CampusMap.clearRoute();
    }

    // 2. Hide Google Maps route preview sheet and floating topbar
    this.hideRoutePreview();

    // 3. Preserve the user's destination input (do not wipe inputs on back)
    this.updateDestinationState(this.currentDestination);

    // 4. Return to default view (Map)
    if (window.UIController) {
      window.UIController.closeLeftPanels();
      window.UIController.switchView("map");
    }
  }

  exitDirections() {
    if (history.state && history.state.depth > 0) {
      try {
        history.back();
        return;
      } catch (err) {}
    }
    this.closeRouteAndReset();
  }

  hideRoutePreview() {
    document.body.classList.remove("gmaps-route-active");
    const topBar = document.getElementById("gmaps-route-topbar");
    const previewSheet = document.getElementById("gmaps-route-preview-sheet");
    if (topBar) topBar.style.display = "none";
    if (previewSheet) previewSheet.style.display = "none";

    const controls = document.querySelector(".map-floating-controls");
    if (controls) controls.style.removeProperty("bottom");
  }

  updateModePillEstimates(distanceStr) {
    const distNum = parseInt(distanceStr) || 600;
    const walkMin = Math.max(1, Math.round(distNum / 75));
    const kartMin = Math.max(1, Math.round(distNum / 220));

    const walkBtn = document.querySelector(".mode-tab-btn[data-mode='walking'] span");
    const kartBtn = document.querySelector(".mode-tab-btn[data-mode='kart'] span");

    if (walkBtn) walkBtn.textContent = `🚶 ${walkMin} min`;
    if (kartBtn) kartBtn.textContent = `🛺 ${kartMin} min`;
  }

  showDetourRerouting() {
    const origin = "Main Gate (Students)";
    const dest = "Block 31 (Admin)";

    const originInput = document.getElementById("direction-origin-input");
    const destInput = document.getElementById("direction-dest-input");
    if (originInput) originInput.value = origin;
    if (destInput) destInput.value = dest;

    const closedPath = [
      [31.258280, 75.706657],
      [31.257209, 75.703848],
      [31.256420, 75.704508]
    ];
    const detourPath = this.roadGraph.findPath(31.260585, 75.707280, 31.252543, 75.704916, this.currentMode);

    if (window.CampusMap) {
      window.CampusMap.drawRoute(
        detourPath || [[31.260585, 75.707280], [31.252543, 75.704916]],
        true,
        closedPath,
        { mode: this.currentMode, originName: origin, destName: dest }
      );
    }
  }

  renderSteps(steps) {
    const stepsListEl = document.getElementById("turn-steps-list");
    if (!stepsListEl) return;

    stepsListEl.innerHTML = "";

    steps.forEach((step) => {
      const stepItem = document.createElement("div");
      stepItem.className = `step-item ${step.isArrival ? "destination" : ""}`;

      let iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`;
      
      if (step.icon === "corner-up-right") {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 14 20 9 15 4"></polyline><path d="M4 20v-7a4 4 0 0 1 4-4h12"></path></svg>`;
      } else if (step.icon === "corner-up-left") {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>`;
      } else if (step.icon === "map-pin") {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
      }

      stepItem.innerHTML = `
        <div class="step-icon-wrapper">${iconSvg}</div>
        <div class="step-instruction">
          <div class="step-main-text">${step.instruction}</div>
          <div class="step-distance">${step.distance}</div>
        </div>
      `;

      stepsListEl.appendChild(stepItem);
    });
  }
}

// Global Directions instance
window.Directions = new DirectionsController();
