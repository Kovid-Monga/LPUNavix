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
  {
    id: "fashion-design-dept",
    name: "School of Fashion Design",
    category: "academics",
    type: "Department",
    tags: ["fashion design", "school of fashion design", "design department"],
    blocks: ["block-1-fashion-design"],
    centerCoords: [31.258597515534394, 75.70874010081363],
    desc: "Department of Fashion Design at LPU.",
    image: ""
  },
  {
    id: "cse-dept",
    name: "School of Computer Science & Engineering (CSE)",
    category: "academics",
    type: "Department Zone",
    tags: ["cse", "computer science", "it", "coding", "software", "btech cse", "cse blocks"],
    blocks: ["block-25", "block-26", "block-27", "block-28", "block-31", "block-32", "block-33", "block-34", "block-36", "block-37", "block-38"],
    centerCoords: [31.25252781150963, 75.7029864749583],
    desc: "Houses the School of Computer Science & Engineering.",
    image: ""
  }
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
    id: "main-gate-parking",
    name: "LPU Main Gate Parking",
    groupId: null,
    groupName: null,
    category: "parking",
    type: "Parking Area",
    lat: 31.259813520055438,
    lng: 75.70608609956477,
    floor: "Ground Level",
    facilities: ["Vehicle Parking", "Security Post"],
    tags: ["lpu main gate parking", "main gate parking", "parking", "vehicle parking"],
    desc: "Parking area near the LPU main gate.",
    hours: "Open 24 Hours",
    phone: "",
    image: ""
  },
  {
    id: "baldev-raj-mittal-park",
    name: "Baldev Raj Mittal Park",
    groupId: null,
    groupName: null,
    category: "others",
    type: "Park",
    lat: 31.258972708092458,
    lng: 75.70693781562309,
    floor: "Ground Level",
    facilities: ["Green Space", "Seating Area"],
    tags: ["baldev raj mittal park", "park", "garden", "green space"],
    desc: "Baldev Raj Mittal Park on the LPU campus.",
    hours: "Open on Campus Schedule",
    phone: "",
    image: ""
  },
  {
    id: "sh-baldevraj-mittal-auditorium",
    name: "Sh. Baldevraj Mittal Auditorium",
    groupId: null,
    groupName: null,
    category: "others",
    type: "Auditorium",
    lat: 31.258442490636092,
    lng: 75.70785810764602,
    floor: "Ground Level",
    facilities: ["Auditorium Hall", "Event Venue"],
    tags: ["sh baldevraj mittal auditorium", "baldevraj mittal auditorium", "auditorium", "event venue"],
    desc: "Sh. Baldevraj Mittal Auditorium on the LPU campus.",
    hours: "Open on Campus Schedule",
    phone: "",
    image: ""
  },
  {
    id: "block-1",
    name: "Block 1",
    groupId: "fashion-design-dept",
    groupName: "School of Fashion Design",
    category: "academics",
    type: "Academic Block",
    lat: 31.258597515534394,
    lng: 75.70874010081363,
    floor: "Academic Block",
    facilities: ["Classrooms", "Design Studios", "Faculty Offices"],
    tags: ["block 1", "block-1", "school of fashion design", "fashion design", "academic block"],
    desc: "Block 1 houses the School of Fashion Design on the LPU campus.",
    hours: "Open on Campus Schedule",
    phone: "",
    image: ""
  },
  {
    id: "uni-health-center",
    name: "Uni Health Center",
    groupId: null,
    groupName: null,
    category: "healthcare",
    type: "Health Center",
    lat: 31.258119604214023,
    lng: 75.70674904051353,
    floor: "Ground Level",
    facilities: ["Medical Assistance", "First Aid", "Doctor Consultation"],
    tags: ["uni health center", "health center", "medical center", "first aid", "healthcare"],
    desc: "Uni Health Center providing healthcare services on the LPU campus.",
    hours: "Open on Campus Schedule",
    phone: "",
    image: ""
  },
  {
    id: "block-25",
    name: "Block 25 (CSE)",
    groupId: "cse-dept",
    groupName: "School of Computer Science & Engineering (CSE)",
    category: "academics",
    type: "Academic Block",
    lat: 31.25285938442377,
    lng: 75.70247885462516,
    floor: "Multi-storey Block",
    facilities: ["Classrooms", "Computer Labs", "Faculty Cabins"],
    tags: ["block 25", "cse", "computer science", "b25", "academic block"],
    desc: "Block 25 - Department of Computer Science & Engineering.",
    hours: "8:00 AM - 5:30 PM",
    phone: "",
    image: ""
  },
  {
    id: "block-26",
    name: "Block 26 (CSE)",
    groupId: "cse-dept",
    groupName: "School of Computer Science & Engineering (CSE)",
    category: "academics",
    type: "Academic Block",
    lat: 31.252861883513926,
    lng: 75.70289512306216,
    floor: "Multi-storey Block",
    facilities: ["Classrooms", "Computer Labs", "Faculty Cabins"],
    tags: ["block 26", "cse", "computer science", "b26", "academic block"],
    desc: "Block 26 - Department of Computer Science & Engineering.",
    hours: "8:00 AM - 5:30 PM",
    phone: "",
    image: ""
  },
  {
    id: "block-27",
    name: "Block 27 (CSE)",
    groupId: "cse-dept",
    groupName: "School of Computer Science & Engineering (CSE)",
    category: "academics",
    type: "Academic Block",
    lat: 31.252858651898666,
    lng: 75.70330718355343,
    floor: "Multi-storey Block",
    facilities: ["Classrooms", "Computer Labs", "Faculty Cabins"],
    tags: ["block 27", "cse", "computer science", "b27", "academic block"],
    hours: "8:00 AM - 5:30 PM",
    phone: "",
    image: ""
  },
  {
    id: "block-28",
    name: "Block 28 (CSE)",
    groupId: "cse-dept",
    groupName: "School of Computer Science & Engineering (CSE)",
    category: "academics",
    type: "Academic Block",
    lat: 31.25284540741938,
    lng: 75.70373386456326,
    floor: "Multi-storey Block",
    facilities: ["Classrooms", "Computer Labs", "Faculty Cabins"],
    tags: ["block 28", "cse", "computer science", "b28", "academic block"],
    desc: "Block 28 - Department of Computer Science & Engineering.",
    hours: "8:00 AM - 5:30 PM",
    phone: "",
    image: ""
  },
  {
    id: "block-32",
    name: "Block 32 (Admin)",
    groupId: "cse-dept",
    groupName: "School of Computer Science & Engineering (CSE)",
    category: "academics",
    type: "Academic Block",
    lat: 31.252169312144662,
    lng: 75.70476168618337,
    floor: "Multi-storey Block",
    facilities: ["Classrooms", "Computer Labs", "Faculty Cabins"],
    tags: ["block 32", "cse", "computer science", "b32", "academic block"],
    desc: "Block 32 - Department of Computer Science & Engineering.",
    hours: "8:00 AM - 5:30 PM",
    phone: "",
    image: ""
  },
  {
    id: "block-33",
    name: "Block 33 (CSE)",
    groupId: "cse-dept",
    groupName: "School of Computer Science & Engineering (CSE)",
    category: "academics",
    type: "Academic Block",
    lat: 31.25182752424929,
    lng: 75.70475097721261,
    floor: "Multi-storey Block",
    facilities: ["Classrooms", "Computer Labs", "Faculty Cabins"],
    tags: ["block 33", "cse", "computer science", "b33", "academic block"],
    desc: "Block 33 - Department of Computer Science & Engineering.",
    hours: "8:00 AM - 5:30 PM",
    phone: "",
    image: ""
  },
  {
    id: "block-34",
    name: "Block 34 (CSE)",
    groupId: "cse-dept",
    groupName: "School of Computer Science & Engineering (CSE)",
    category: "academics",
    type: "Academic Block",
    lat: 31.25148864838823,
    lng: 75.7047360500708,
    floor: "Multi-storey Block",
    facilities: ["Classrooms", "Computer Labs", "Faculty Cabins"],
    tags: ["block 34", "cse", "computer science", "b34", "academic block"],
    desc: "Block 34 - Department of Computer Science & Engineering.",
    hours: "8:00 AM - 5:30 PM",
    phone: "",
    image: ""
  },
  {
    id: "block-36",
    name: "Block 36 (CSE)",
    groupId: "cse-dept",
    groupName: "School of Computer Science & Engineering (CSE)",
    category: "academics",
    type: "Academic Block",
    lat: 31.2516333779156,
    lng: 75.70412763243169,
    floor: "Multi-storey Block",
    facilities: ["Classrooms", "Computer Labs", "Faculty Cabins"],
    tags: ["block 36", "cse", "computer science", "b36", "academic block"],
    desc: "Block 36 - Department of Computer Science & Engineering.",
    hours: "8:00 AM - 5:30 PM",
    phone: "",
    image: ""
  },
  {
    id: "block-37",
    name: "Block 37 (CSE)",
    groupId: "cse-dept",
    groupName: "School of Computer Science & Engineering (CSE)",
    category: "academics",
    type: "Academic Block",
    lat: 31.251858851005732,
    lng: 75.70373201751212,
    floor: "Multi-storey Block",
    facilities: ["Classrooms", "Computer Labs", "Faculty Cabins"],
    tags: ["block 37", "cse", "computer science", "b37", "academic block"],
    desc: "Block 37 - Department of Computer Science & Engineering.",
    hours: "8:00 AM - 5:30 PM",
    phone: "",
    image: ""
  },
  {
    id: "block-38",
    name: "Block 38 (CSE)",
    groupId: "cse-dept",
    groupName: "School of Computer Science & Engineering (CSE)",
    category: "academics",
    type: "Academic Block",
    lat: 31.252140287536804,
    lng: 75.70338135340346,
    floor: "Multi-storey Block",
    facilities: ["Classrooms", "Computer Labs", "Faculty Cabins"],
    tags: ["block 38", "cse", "computer science", "b38", "academic block"],
    desc: "Block 38 - Department of Computer Science & Engineering.",
    hours: "8:00 AM - 5:30 PM",
    phone: "",
    image: ""
  },
  {
    id: "block-31",
    name: "Block 31 (Admin)",
    groupId: "cse-dept",
    groupName: "School of Computer Science & Engineering (CSE)",
    category: "offices",
    type: "Administrative & Academic Block",
    lat: 31.252443962233237,
    lng: 75.70496872629623,
    floor: "Multi-storey Block",
    facilities: ["Administrative Offices", "Classrooms", "Computer Labs", "Faculty Cabins"],
    tags: ["block 31", "admin", "administration", "cse", "computer science", "b31", "administrative block"],
    desc: "Block 31 - Administrative Block & CSE Department.",
    hours: "8:00 AM - 5:30 PM",
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
// 3. 🏢 CAMPUS OFFICES (Shown on the map only at block-level zoom) - ADD YOURS HERE
// ============================================================================
var CAMPUS_OFFICES = window.CAMPUS_OFFICES = [
  {
    id: "office-admin-28-209",
    name: "Administrative Office (Block 28, Room 209)",
    groupId: "cse-dept",
    groupName: "School of Computer Science & Engineering (CSE)",
    category: "offices",
    type: "Administrative Office",
    parentBlockIds: ["block-27", "block-28"],
    visibleFromZoom: 19,
    lat: 31.252754224964615,
    lng: 75.70378526355849,
    floor: "Second Floor, Room 209",
    facilities: ["Lost and Found", "Infrastructure Queries", "Faculty Details", "General Queries"],
    tags: ["administrative office", "admin office", "block 27", "block 28", "room 209", "lost and found", "infrastructure", "faculty details", "general queries"],
    desc: "Administrative office serving Blocks 27 and 28 for lost and found, infrastructure queries, faculty details, and general queries.",
    hours: "8:00 AM - 5:30 PM",
    phone: "",
    image: ""
  }
];

// ============================================================================
// 4. 🛺 ACTIVE CAMPUS KARTS (Live tracking shuttles) - ADD YOURS HERE
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
// 5. 🤖 AI ASSISTANT KNOWLEDGE BASE - ADD YOURS HERE
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
  return getAllCampusLocations().filter(loc => loc.groupId === groupId);
}

function getAllCampusLocations() {
  return [...CAMPUS_LOCATIONS, ...CAMPUS_OFFICES];
}

function getGroupById(groupId) {
  return CAMPUS_GROUPS.find(g => g.id === groupId);
}
