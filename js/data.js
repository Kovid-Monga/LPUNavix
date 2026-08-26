/**
 * LPU Map - Campus Relational Data Store
 * Ready for your custom campus datasets.
 */

// LPU Campus Center Coordinate
const CAMPUS_CENTER = [31.2536, 75.7037];

// ============================================================================
// 1. 🏛️ CAMPUS GROUPS (Departments, Food Courts, Clusters) - ADD YOURS HERE
// ============================================================================
const CAMPUS_GROUPS = [
  // --- TEMPLATE EXAMPLE (Add your own groups below) ---
  //   {
  //     id: "cse-dept",
  //     name: "School of Computer Science & Engineering (CSE)",
  //     category: "academics", // 'academics' | 'hostels' | 'food' | 'parking' | 'offices' | 'healthcare' | 'others'
  //     type: "Department Zone",
  //     tags: ["cse", "computer science", "it", "coding", "software", "btech cse", "cse blocks"],
  //     blocks: ["block-25", "block-28"], // List of child block IDs
  //     centerCoords: [31.2546, 75.7031],
  //     desc: "Houses the School of Computer Science & Engineering.",
  //     image: "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=600"
  //   }
];

// // ============================================================================
// // 2. 📍 INDIVIDUAL CAMPUS LOCATIONS (Blocks, Labs, Shops) - ADD YOURS HERE
// // ============================================================================
var CAMPUS_LOCATIONS = window.CAMPUS_LOCATIONS = [
  // --- Main Gates ---
  {
    id: "main-gate-vehicle",
    name: "Main Gate (Vehicles)",
    groupId: null,
    groupName: null,
    category: "parking",
    type: "Campus Entrance",
    lat: 31.260758,
    lng: 75.706920,
    floor: "Roadway Checkpoint",
    facilities: ["Security Post", "Vehicle Boom Barrier"],
    tags: ["main gate", "vehicle gate", "car entry", "gate", "entry"],
    desc: "Primary entrance and exit gate for vehicles.",
    hours: "Open 24 Hours",
    phone: "",
    image: ""
  },
  {
    id: "main-gate-students",
    name: "Main Gate (Students)",
    groupId: null,
    groupName: null,
    category: "others",
    type: "Pedestrian Gate",
    lat: 31.260585,    // 31°15'38.0"N
    lng: 75.707280,    // 75°42'26.1"E
    floor: "Pedestrian Entry",
    facilities: ["RFID Turnstiles", "Security Guardhouse"],
    tags: ["student gate", "main gate", "pedestrian", "entry", "gate"],
    desc: "Main pedestrian entry for students and staff.",
    hours: "Open 24 Hours",
    phone: "",
    image: ""
  }
];

// ============================================================================
// 3. 🛺 ACTIVE CAMPUS KARTS (Live tracking shuttles) - ADD YOURS HERE
// ============================================================================
const CAMPUS_KARTS = [
  // --- TEMPLATE EXAMPLE ---
  {
    id: "kart-1",
    name: "Electric Shuttle #1",
    route: "Main Gate ➔ UniMall ➔ Block 31 ➔ Block 28",
    location: "Near Main Gate Stop",
    eta: "2 mins away",
    status: "active",
    lat: 31.2522,
    lng: 75.6990
  }
];

// ============================================================================
// 4. 🤖 AI ASSISTANT KNOWLEDGE BASE - ADD YOURS HERE
// ============================================================================
const AI_KNOWLEDGE_BASE = [
  // --- TEMPLATE EXAMPLE ---
  {
    triggers: ["cse", "computer science", "cse block"],
    question: "Where is the CSE Department?",
    answer: "The **School of Computer Science & Engineering (CSE)** is located in the CSE Zone.",
    groupId: "cse-dept",
    locationId: "block-28"
  }
];

// Helper Functions
function getLocationsByGroupId(groupId) {
  return CAMPUS_LOCATIONS.filter(loc => loc.groupId === groupId);
}

function getGroupById(groupId) {
  return CAMPUS_GROUPS.find(g => g.id === groupId);
}
