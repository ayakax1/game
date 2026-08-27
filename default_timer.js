// библиотека для работы со стандартными длинами матчей

import { GameMode } from 'pixel_combats/room';

// константы
const PARAMETER_GAME_LENGTH = 'GameLength';

// возвращает длину матча
export function game_mode_length_seconds() {
    const length = GameMode.Parameters.GetString(PARAMETER_GAME_LENGTH);
    switch (length) {
        case 'Length_S': return 210; // 3:30
        case 'Length_M': return 270; // 4:30
        case 'Length_L': return 330; // 5:30
        case 'Length_XL': return 390; // 6:30
    }
    return 270;
}