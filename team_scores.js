// модуль для начисления очков и киллов в команду
// комментарии — на русском

export const TEAM_SCORES_MUL = 0.08;
const SCORES_PROP_NAME = "Scores";
const KILLS_PROP_NAME = "Kills";

// добавляет очки в команду с масштабированием 8% от очков игрока
export function addTeamScores(team, playerScoresToScale) {
	if (!team) return;
	const scaled = Math.round((playerScoresToScale | 0) * TEAM_SCORES_MUL);
	if (scaled <= 0) return;
	const teamProp = team.Properties ? team.Properties.Get(SCORES_PROP_NAME) : null;
	if (teamProp) teamProp.Value += scaled;
}

// добавляет очки в команду без масштабирования (сырые очки команды)
export function addTeamScoresRaw(team, teamScores) {
	if (!team) return;
	const add = teamScores | 0;
	if (add === 0) return;
	const teamProp = team.Properties ? team.Properties.Get(SCORES_PROP_NAME) : null;
	if (teamProp) teamProp.Value += add;
}

// [PC2] увеличивает счётчик киллов команды на 1
// используется для отображения счёта сверху экрана по количеству киллов команды
export function addTeamKill(team) {
	if (!team) return;
	const teamProp = team.Properties ? team.Properties.Get(KILLS_PROP_NAME) : null;
	if (teamProp) teamProp.Value += 1;
}
