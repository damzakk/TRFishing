const { makeGroups } = require("../src/worldTournament");

const settings = { standardTurns: 15, finalTurns: 25 };

function checkGroupAssignment(count, targetSize, expectedSizes) {
  const participantIds = Array.from({ length: count }, (_, index) => `participant-${index + 1}`);
  const groups = makeGroups(participantIds, targetSize, 1, settings);
  const assignedIds = groups.flatMap((group) => group.participantIds);

  if (groups.map((group) => group.participantIds.length).join(",") !== expectedSizes.join(",")) {
    throw new Error(`Unexpected group sizes for ${count} participants: ${groups.map((group) => group.participantIds.length).join(",")}`);
  }
  if (assignedIds.length !== count || new Set(assignedIds).size !== count || !participantIds.every((id) => assignedIds.includes(id))) {
    throw new Error(`Participant assignment is incomplete or duplicated for ${count} participants.`);
  }
}

checkGroupAssignment(15, 5, [5, 5, 5]);
checkGroupAssignment(16, 5, [6, 5, 5]);
checkGroupAssignment(14, 5, [5, 5, 4]);
console.log("World Fish Competition group assignment checks passed.");
