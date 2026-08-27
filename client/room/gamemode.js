import { DisplayValueHeader } from 'pixel_combats/basic';
import * as room_lib from 'pixel_combats/room';
const { room, Game, Players, Inventory, LeaderBoard, BuildBlocksSet, Teams, Damage, BreackGraph, Ui, Properties, GameMode, Spawns, Timers, TeamsBalancer, NewGame, MapEditor, Analytics, Map } = room_lib;
import * as teams from './default_teams.js';
import * as damageScores from './damage_scores.js';
import * as mapScores from './map_scores.js';
import { addTeamScores, addTeamKill } from './team_scores.js';

room.PopupsEnable = true;

/* ==========================================================================
   PC2: доработка TDM для Pixel Combats League
   Изменения относительно оригинального TDM:
   1) По окончании матча итоги/статистика игроков отправляются через
      Analytics.LogEvent (см. функцию sendMatchAnalytics ниже).
      ВАЖНО: это НЕ отправка на внешний сайт (pc2s.pages.dev) — у
      скрипта режима нет доступа к сети/HTTP, только к внутренней
      аналитике Pixel Combats. Подробности — в чате, где это передавалось.
   2) Основной бой всегда длится 6:00 (360 секунд), независимо от
      размера карты — GameLength больше не влияет на длительность.
   3) Счёт команд сверху экрана (TeamProp1/TeamProp2) теперь показывает
      количество киллов команды, а не очки (Scores).
   4) Голосование за карту убрано полностью. После итогов матча сервер
      всегда перезапускается на той же карте, с которой был создан.
   ========================================================================== */

// настройки
const WaitingPlayersTime = 10;
const TacticalPreparationTime = 30;
const OvertimeTime = 30;
const OvertimePauseTime = 3;
const MockModeTime = 10;
const EndOfMatchTime = 8;

// [PC2] пункт 2: основной бой всегда 6:00, вне зависимости от карты/GameLength
const MATCH_TIME_SECONDS = 360; // 6:00

// очки
const WINNER_SCORES = 30;  		// очки за победу
const LOSER_SCORES = 15;			// очки за поражение
const TIMER_SCORES = 30;			// очки за проведенное время
const TIMER_SCORES_INTERVAL = 30;	// интервал таймера очков

// имена используемых объектов
const WaitingStateValue = "Waiting";
const TacticalPreparationStateValue = "TacticalPreparation";
const GameStateValue = "Game";
const OvertimeStateValue = "Overtime";        // овертайм - 30 сек решающий бой с бесконечными патронами
const TieBreakerStateValue = "TieBreaker";    // финальный фраг - игра до первого убийства при ничьей
const MockModeStateValue = "MockMode";
const EndOfMatchStateValue = "EndOfMatch";

const immortalityTimerName = "immortality"; // имя таймера, используемого в контексте игрока, для его бессмертия
const KILLS_PROP_NAME = "Kills";
const ASSISTS_PROP_NAME = "Assists";
const SCORES_PROP_NAME = "Scores";

// получаем объекты, с которыми работает режим
const mainTimer = Timers.GetContext().Get("Main");
const scores_timer = Timers.GetContext().Get("Scores");
const stateProp = Properties.GetContext().Get("State");

// применяем параметры конструктора режима
Damage.GetContext().FriendlyFire.Value = GameMode.Parameters.GetBool("FriendlyFire");
BreackGraph.WeakBlocks = GameMode.Parameters.GetBool("LoosenBlocks");
BreackGraph.OnlyPlayerBlocksDmg = GameMode.Parameters.GetBool("OnlyPlayerBlocksDmg");

// бустим блоки игрока
BreackGraph.PlayerBlockBoost = true;

// имя игрового режима (устарело)
Properties.GetContext().GameModeName.Value = "GameModes/Team Dead Match";
TeamsBalancer.IsAutoBalance = true;
Ui.GetContext().MainTimerId.Value = mainTimer.Id;
// создаем стандартные команды
const blueTeam = teams.create_team_blue();
const redTeam = teams.create_team_red();
blueTeam.Build.BlocksSet.Value = BuildBlocksSet.Blue;
redTeam.Build.BlocksSet.Value = BuildBlocksSet.Red;

// настраиваем параметры, которые нужно выводить в лидерборде
LeaderBoard.PlayerLeaderBoardValues = [
	new DisplayValueHeader(KILLS_PROP_NAME, "Statistics/Kills", "Statistics/KillsShort"),
	new DisplayValueHeader(ASSISTS_PROP_NAME, "Statistics/Assists", "Statistics/AssistsShort"),
	new DisplayValueHeader("Deaths", "Statistics/Deaths", "Statistics/DeathsShort"),
	new DisplayValueHeader("Spawns", "Statistics/Spawns", "Statistics/SpawnsShort"),
	new DisplayValueHeader(SCORES_PROP_NAME, "Statistics/Scores", "Statistics/ScoresShort")
];
LeaderBoard.TeamLeaderBoardValue = new DisplayValueHeader(SCORES_PROP_NAME, "Statistics\\Scores", "Statistics\\Scores");
// задаем сортировку команд для списка лидирующих по командному свойству
// (победитель матча по-прежнему определяется по очкам Scores, а не по киллам —
//  пункт 3 задания касается только счёта, отображаемого сверху экрана)
LeaderBoard.TeamWeightGetter.Set(function (team) {
	return team.Properties.Get(SCORES_PROP_NAME).Value;
});
// задаем сортировку игроков для списка лидирующих
LeaderBoard.PlayersWeightGetter.Set(function (player) {
	return player.Properties.Get(SCORES_PROP_NAME).Value;
});

// отображаем изначально нули в очках и киллах команд
redTeam.Properties.Get(SCORES_PROP_NAME).Value = 0;
blueTeam.Properties.Get(SCORES_PROP_NAME).Value = 0;
redTeam.Properties.Get(KILLS_PROP_NAME).Value = 0;
blueTeam.Properties.Get(KILLS_PROP_NAME).Value = 0;

// [PC2] пункт 3: счёт сверху экрана — по киллам команды (KILLS_PROP_NAME), а не по очкам
Ui.GetContext().TeamProp1.Value = { Team: "Blue", Prop: KILLS_PROP_NAME };
Ui.GetContext().TeamProp2.Value = { Team: "Red", Prop: KILLS_PROP_NAME };

// при запросе смены команды игрока - добавляем его в запрашиваемую команду
Teams.OnRequestJoinTeam.Add(function (player, team) { team.Add(player); });
// при запросе спавна игрока - спавним его
Teams.OnPlayerChangeTeam.Add(function (player) {
	// [PC2] явно инициализируем Assists нулём — иначе колонка "A" в лидерборде
	// остаётся пустой у игроков, которые ещё ни разу не получили ассист
	player.Properties.Assists.Value = player.Properties.Assists.Value || 0;
	player.Spawns.Spawn();
});

// бессмертие после респавна
Spawns.GetContext().OnSpawn.Add(function (player) {
	if (stateProp.Value == MockModeStateValue) {
		player.Properties.Immortality.Value = false;
		return;
	}
	player.Properties.Immortality.Value = true;
	player.Timers.Get(immortalityTimerName).Restart(3);
});
Timers.OnPlayerTimer.Add(function (timer) {
	if (timer.Id != immortalityTimerName) return;
	timer.Player.Properties.Immortality.Value = false;
});

// обработчик спавнов
Spawns.OnSpawn.Add(function (player) {
	if (stateProp.Value == MockModeStateValue) return;
	++player.Properties.Spawns.Value;
});
// обработчик смертей
Damage.OnDeath.Add(function (player) {
	if (stateProp.Value == MockModeStateValue) {
		Spawns.GetContext(player).Spawn();
		return;
	}
	++player.Properties.Deaths.Value;
});

// детальный отчёт по убийству: начисляем очки за убийство и ассисты
Damage.OnKillReport.Add(function (victim, killer, report) {
	if (stateProp.Value == MockModeStateValue) return;
	damageScores.applyKillReportScores(victim, killer, report);

	// [PC2] пункт 3: если убийца из другой команды — засчитываем килл команде
	if (killer && victim && killer.Team != null && victim.Team != null && killer.Team != victim.Team) {
		addTeamKill(killer.Team);
	}

	// если это TieBreaker (ничья в овертайме), завершаем игру
	if (stateProp.Value === TieBreakerStateValue) {
		SetEndOfMatch_EndMode();
	}
});

// начисление очков за редактирование карты
MapEditor.OnMapEdited.Add(function (player, details) {
	if (stateProp.Value == MockModeStateValue) return;
	mapScores.applyMapEditScores(player, details, blueTeam, redTeam);
});

// таймер очков за проведенное время (только в основной фазе)
scores_timer.OnTimer.Add(function () {
	if (stateProp.Value !== GameStateValue) return;
	for (const player of Players.All) {
		if (player.Team == null) continue; // если вне команд то не начисляем
		player.Properties.Scores.Value += TIMER_SCORES;
		addTeamScores(player.Team, TIMER_SCORES);
	}
});

// таймер переключения состояний
mainTimer.OnTimer.Add(function () {
	switch (stateProp.Value) {
		case WaitingStateValue:
			SetTacticalPreparation();
			break;
		case TacticalPreparationStateValue:
			SetGameMode();
			break;
		case GameStateValue:
			CheckForOvertime();
			break;
		case OvertimeStateValue:
			// завершаем овертайм
			SetEndOfMatch();
			break;
		case TieBreakerStateValue:
			// TieBreaker завершается только при убийстве
			break;
		case MockModeStateValue:
			SetEndOfMatch_EndMode();
			break;
		case EndOfMatchStateValue:
			// [PC2] пункт 4: вместо голосования — прямой рестарт той же картой
			restart_same_map();
			break;
	}
});

// изначально задаем состояние ожидания других игроков
SetWaitingMode();

// состояния игры
function SetWaitingMode() {
	stateProp.Value = WaitingStateValue;
	Ui.GetContext().Hint.Value = "Hint/WaitingPlayers";
	Spawns.GetContext().enable = false;
	mainTimer.Restart(WaitingPlayersTime);
}
function SetTacticalPreparation() {
	stateProp.Value = TacticalPreparationStateValue;
	Ui.GetContext().Hint.Value = "Hint/TacticalPrep";
	var inventory = Inventory.GetContext();
	inventory.Main.Value = false;
	inventory.Secondary.Value = false;
	inventory.Melee.Value = true;
	inventory.Explosive.Value = false;
	inventory.Build.Value = true;
	// урон включен, быстрый респавн
	Damage.GetContext().DamageOut.Value = true;
	Spawns.GetContext().RespawnTime.Value = 2;

	mainTimer.Restart(TacticalPreparationTime);
	Spawns.GetContext().enable = true;
	SpawnTeams();
}
function SetGameMode() {
	// разрешаем нанесение урона
	Damage.GetContext().DamageOut.Value = true;
	stateProp.Value = GameStateValue;
	Ui.GetContext().Hint.Value = "Hint/MainBattle";

	var inventory = Inventory.GetContext();
	if (GameMode.Parameters.GetBool("OnlyKnives")) {
		inventory.Main.Value = false;
		inventory.Secondary.Value = false;
		inventory.Melee.Value = true;
		inventory.Explosive.Value = false;
		inventory.Build.Value = true;
	} else {
		inventory.Main.Value = true;
		inventory.Secondary.Value = true;
		inventory.Melee.Value = true;
		inventory.Explosive.Value = true;
		inventory.Build.Value = true;
	}

	// [PC2] пункт 2: время основного боя фиксировано — 6:00, размер карты не влияет
	mainTimer.Restart(MATCH_TIME_SECONDS);
	Spawns.GetContext().Despawn();
	SpawnTeams();
}
// проверка необходимости овертайма
function CheckForOvertime() {
	scores_timer.Stop(); // выключаем таймер очков
	const leaderboard = LeaderBoard.GetTeams();
	const team1Score = leaderboard[0].Weight;
	const team2Score = leaderboard[1].Weight;

	// проверяем условие овертайма: разница команд ≤ 10%
	const maxScore = Math.max(team1Score, team2Score);
	const minScore = Math.min(team1Score, team2Score);
	const difference = maxScore > 0 ? (maxScore - minScore) / maxScore : 0;

	if (difference <= 0.1) {
		// запускаем овертайм
		SetOvertime();
	} else {
		// сразу переходим к завершению
		SetEndOfMatch();
	}
}

// функция овертайма
function SetOvertime() {
	stateProp.Value = OvertimeStateValue;
	Ui.GetContext().Hint.Value = "Hint/Overtime";

	// включаем бесконечные патроны для всех
	var inventory = Inventory.GetContext();
	inventory.MainInfinity.Value = true;
	inventory.SecondaryInfinity.Value = true;
	inventory.ExplosiveInfinity.Value = true;

	// запускаем овертайм на 30 секунд
	mainTimer.Restart(OvertimeTime);
}

function SetEndOfMatch() {
	scores_timer.Stop(); // выключаем таймер очков
	const leaderboard = LeaderBoard.GetTeams();
	if (leaderboard[0].Weight !== leaderboard[1].Weight) {
		// режим прикола вконце катки
		SetMockMode(leaderboard[0].Team, leaderboard[1].Team);
		// добавляем очки победившим
		for (const win_player of leaderboard[0].Team.Players) {
			win_player.Properties.Scores.Value += WINNER_SCORES;
		}
		// добавляем очки проигравшим
		for (const lose_player of leaderboard[1].Team.Players) {
			lose_player.Properties.Scores.Value += LOSER_SCORES;
		}
	}
	else {
		// ничья - играем до первого очка
		if (stateProp.Value === OvertimeStateValue) {
			stateProp.Value = TieBreakerStateValue;
			Ui.GetContext().Hint.Value = "Hint/TieBreaker";
		} else {
			SetEndOfMatch_EndMode();
		}
	}
}
function SetMockMode(winners, loosers) {
	// задаем состояние игры
	stateProp.Value = MockModeStateValue;
	scores_timer.Stop(); // выключаем таймер очков

	// подсказка
	Ui.GetContext(winners).Hint.Value = "Hint/MockHintForWinners";
	Ui.GetContext(loosers).Hint.Value = "Hint/MockHintForLoosers";

	// разрешаем нанесение урона
	Damage.GetContext().DamageOut.Value = true;
	// время спавна
	Spawns.GetContext().RespawnTime.Value = 2;

	// set loosers
	var inventory = Inventory.GetContext(loosers);
	inventory.Main.Value = false;
	inventory.Secondary.Value = false;
	inventory.Melee.Value = false;
	inventory.Explosive.Value = false;
	inventory.Build.Value = false;

	// set winners
	inventory = Inventory.GetContext(winners);
	inventory.MainInfinity.Value = true;
	inventory.SecondaryInfinity.Value = true;
	inventory.ExplosiveInfinity.Value = true;
	inventory.BuildInfinity.Value = true;

	// перезапуск таймера мода
	mainTimer.Restart(MockModeTime);
}
function SetEndOfMatch_EndMode() {
	stateProp.Value = EndOfMatchStateValue;
	scores_timer.Stop(); // выключаем таймер очков
	Ui.GetContext().Hint.Value = "Hint/EndOfMatch";

	var spawns = Spawns.GetContext();
	spawns.enable = false;
	spawns.Despawn();

	const finalTeamsBoard = LeaderBoard.GetTeams();

	// [PC2] важно: сначала гарантированно завершаем матч и ставим таймер
	// на рестарт — это критичный путь, он не должен зависеть от аналитики.
	Game.GameOver(finalTeamsBoard);
	mainTimer.Restart(EndOfMatchTime);

	// [PC2] пункт 1: отправляем итоги матча через Analytics.LogEvent.
	// Обёрнуто в try/catch: если формат вызова аналитики не подойдёт
	// движку, это никогда не должно ломать рестарт сервера.
	try {
		sendMatchAnalytics(finalTeamsBoard);
	} catch (e) {
		// намеренно проглатываем ошибку аналитики — рестарт важнее
	}
}

// [PC2] пункт 1: сбор и отправка итогов матча
// ВНИМАНИЕ: Analytics.LogEvent уходит во внутреннюю аналитику Pixel Combats,
// а НЕ на внешний сайт pc2s.pages.dev — это единственный канал "наружу",
// доступный скрипту режима согласно документации API.
function sendMatchAnalytics(finalTeamsBoard) {
	// сводка по матчу
	const mapId = Map ? Map.MapId : 0;
	const blueScore = blueTeam.Properties.Get(SCORES_PROP_NAME).Value;
	const redScore = redTeam.Properties.Get(SCORES_PROP_NAME).Value;
	const blueKills = blueTeam.Properties.Get(KILLS_PROP_NAME).Value;
	const redKills = redTeam.Properties.Get(KILLS_PROP_NAME).Value;
	const winnerTeamId = (finalTeamsBoard && finalTeamsBoard[0]) ? finalTeamsBoard[0].Team.Id : "";

	// параметры передаются как обычные JS-объекты вида { ИмяПараметра: значение },
	// как показано в примере из документации сервиса Analytics
	Analytics.LogEvent(
		"PC2_MatchEnded",
		{ MapId: mapId },
		{ BlueScore: blueScore },
		{ RedScore: redScore },
		{ BlueKills: blueKills },
		{ RedKills: redKills },
		{ Winner: winnerTeamId }
	);

	// по одному событию на игрока — со статистикой
	for (const player of Players.All) {
		Analytics.LogEvent(
			"PC2_PlayerMatchResult",
			{ PlayerId: player.Id },
			{ Nickname: player.NickName },
			{ Team: player.Team ? player.Team.Id : "" },
			{ Kills: player.Properties.Kills.Value },
			{ Deaths: player.Properties.Deaths.Value },
			{ Scores: player.Properties.Scores.Value }
		);
	}
}

// [PC2] пункт 4: рестарт строго на той же карте, с которой была создана комната
// (MapId = 0 у NewGame означает "оставить текущую карту")
function restart_same_map() {
	NewGame.RestartGame();
}

function SpawnTeams() {
	for (const team of Teams)
		Spawns.GetContext(team).Spawn();
}

scores_timer.RestartLoop(TIMER_SCORES_INTERVAL);
