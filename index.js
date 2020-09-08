const socketio = require('socket.io');
const properties = require('./properties.json');
const words = require('./api/db/words');

let io = undefined;
const rooms = new Map();

console.log('Starting WebSocket server');
io = socketio(process.env.SOCKET_SERVER_PORT);

io.on('connection', async (player) => {
    initPlayer(player);

    const roomID = player.roomID;
    player.join(roomID);

    if (io.sockets.adapter.rooms[roomID].length === 1) {
        player.isOwner = true;
        rooms.set(player.roomID, createRoom(player.roomID));
        addSettingsListeners(player);
    }

    const room = rooms.get(player.roomID);
    player.emit('setSettings', room.settings);

    console.debug(`[${roomID}] User ${player.username} has joined room `);
    addPlayerSettingsListeners(player);

    player.on('disconnect', () => {
        console.debug(`[${roomID}] User ${player.username} has left room`);

        // FIXME: Check if is in game or not
        const players = rooms.get(roomID).players;
        let playerIndex = players.indexOf(player);
        if (playerIndex === players.length - 1) {
            players.splice(playerIndex, 1);
        } else {
            const lastPlayerIndex = players.length - 1;
            players[playerIndex] = players[lastPlayerIndex];
            players[playerIndex].playerIndex = playerIndex;
            players.splice(lastPlayerIndex, 1);
        }
        player.to(roomID).emit('onDisconnect', playerIndex);
    });

    rooms.get(roomID).players.forEach(other => player.emit('addPlayer', {
        playerIndex: other.playerIndex,
        username: other.username,
        avatar: other.avatar,
        hints: [],
        guess: undefined,
        score: 0
    }));

    player.emit('setPlayerIndex', player.playerIndex);

    io.to(roomID).emit('addPlayer', {
        playerIndex: player.playerIndex,
        username: player.username,
        avatar: player.avatar,
        hints: [],
        guess: undefined,
        score: 0
    });

    rooms.get(roomID).players.push(player);
});

const startGame = (roomID) => {
    const room = rooms.get(roomID);

    console.debug(`[${roomID}] Starting game`);
    room.players.forEach(player => {
        player.score = 0;
    });
    io.to(roomID).emit('startGame');
};

const startRound = async (roomID) => {
    const room = rooms.get(roomID);

    console.debug(`[${roomID}] Starting round`);
    await initRound(roomID);

    io.to(roomID).emit('startRound');

    // Send players the appropriate words
    room.players.forEach(player => {
        switch (player.role) {
            case 'Undercover': {
                player.word = room.undercoverWord;
                player.emit('setWord', room.undercoverWord);
                break;
            }
            case 'MisterWhite': {
                player.word = undefined;
                player.emit('setWord', undefined);
                break;
            }
            default: {
                player.word = room.normalWord;
                player.emit('setWord', room.normalWord);
            }
        }
    });

    let playerTurn = room.players[Math.floor(Math.random() * room.players.length)];
    io.to(roomID).emit('setPlayerTurn', playerTurn.playerIndex);

    room.players.forEach(player => {
        player.on('addHint', hint => {
            // TODO: Check if not undefined
            console.debug('Player ', player.username, ' added hint: ', hint);

            player.hints.push(hint);
            player.to(roomID).emit('addHint', { hint, playerIndex: player.playerIndex });
            playerTurn = room.players[(room.players.indexOf(playerTurn) + 1) % room.players.length]; // next player turn
            if (playerTurn.hints.length === room.settings.wordPerRoundCount) {
                startGuess(roomID);
            } else {
                console.debug('Player turn: ', playerTurn.playerIndex);
                io.to(roomID).emit('setPlayerTurn', playerTurn.playerIndex);
            }
        });
    });
};

const startGuess = (roomID) => {
    const room = rooms.get(roomID);

    let guessCount = 0;
    console.debug('Guess start');

    rooms.get(roomID).players.forEach((player) => {
        player.emit('startGuess');

        player.on('setGuess', playerIndex => {
            player.to(roomID).emit('setGuess', { target: playerIndex, guesser: player.playerIndex });
            player.guess = room.players[playerIndex];
        });

        player.on('setMisterWhiteGuess', playerIndex => {
            player.to(roomID).emit('setMisterWhiteGuess', { target: playerIndex, guesser: player.playerIndex });
            player.misterWhiteGuess = room.players[playerIndex];
        });

        player.once('setHasConfirmedGuess', () => {
            player.to(roomID).emit('setHasConfirmedGuess', player.playerIndex);

            // Check if all players validated their guesses
            guessCount++;
            if (guessCount === rooms.get(roomID).players.length) {
                if (room.settings.misterWhite) {
                    room.misterWhite.once('setGuessWord', guessWord => {
                        room.misterWhite.guessWord = guessWord;
                        room.misterWhite.to(roomID).emit('setGuessWord', guessWord);
                        stopRound(roomID);
                    });
                    room.misterWhite.emit('startGuessWord');
                } else {
                    stopRound(roomID);
                }
            }
        });
    });
};

const stopRound = async (roomID) => {
    const room = rooms.get(roomID);

    // TODO: Replace this
    room.players.forEach(player => {
        player.removeAllListeners('addHint');
        player.removeAllListeners('setGuess');
    });

    let round = {
        normalWord: room.normalWord,
        undercoverWord: room.undercoverWord,
        undercovers: room.undercovers.map(undercover => undercover.playerIndex),
        misterWhite: room.misterWhite ? room.misterWhite.playerIndex : undefined
    };

    io.to(roomID).emit('startScoreboard', round);

    // Undercover found
    for (const player of room.players) {
        if (player.guess && room.undercovers.includes(player.guess)) {
            console.debug(`[${roomID}] ${player.username} found the undercover and won ${properties.gameSettings.score.playerFoundUndercover} pts`);
            player.score += properties.gameSettings.score.playerFoundUndercover;
            addScoreToPlayer(roomID, player.playerIndex, properties.gameSettings.score.playerFoundUndercover, 'Undercover trouvé');
        }
    }
    await delay(1500);

    // Mister white found
    for (const player of room.players) {
        if (player.misterWhiteGuess && player.misterWhiteGuess === room.misterWhite) {
            console.debug(`[${roomID}] ${player.username} found the Mister white and won ${properties.gameSettings.score.playerFoundMisterWhite} pts`);
            player.score += properties.gameSettings.score.playerFoundMisterWhite;
            addScoreToPlayer(roomID, player.playerIndex, properties.gameSettings.score.playerFoundMisterWhite, 'MisterWhite trouvé');
        }
    }
    await delay(1500);

    // Undercover not found
    for (const player of room.players) {
        if (player.role === 'Undercover') {
            // Check if other players guessed the undercover
            let found = false;
            room.players.forEach(other => {
                if (other.guess === player) {
                    found = true;
                }
            });

            if (!found) {
                console.debug(`[${roomID}] ${player.username} was not found as Undercover and won ${properties.gameSettings.score.undercoverNotFound} pts`);
                player.score += properties.gameSettings.score.undercoverNotFound;
                addScoreToPlayer(roomID, player.playerIndex, properties.gameSettings.score.undercoverNotFound, 'Undercover inaperçu');
            }
        }
    }
    await delay(1500);

    // Word found
    for (const player of room.players) {
        if (player.role === 'MisterWhite') {
            if (player.guessWord.toLowerCase() === room.normalWord.toLowerCase()) {
                console.debug(`[${roomID}] ${player.username} found the word and won ${properties.gameSettings.score.misterWhiteFoundWord} pts`);
                player.score += properties.gameSettings.score.misterWhiteFoundWord;
                addScoreToPlayer(roomID, player.playerIndex, properties.gameSettings.score.misterWhiteFoundWord, 'A deviner le mot');
            }
        }
    }
};

const addScoreToPlayer = (roomID, playerIndex, score, reason) => {
    io.to(roomID).emit('addScore', { playerIndex: playerIndex, score: score, reason: reason });
};

function delay (ms) {
    return new Promise(function (resolve, reject) {
        setTimeout(resolve, ms);
    });
}

const createRoom = (roomID) => {
    return {
        players: [],
        gameState: 'lobby',

        normalWord: undefined,
        undercoverWord: undefined,

        undercovers: [],
        misterWhite: undefined,

        settings: {
            undercoverCount: properties.gameSettings.undercoverCount,
            misterWhite: properties.gameSettings.misterWhite,
            wordPerRoundCount: properties.gameSettings.wordPerRoundCount,
            roundPerGameCount: properties.gameSettings.roundPerGameCount,
            roomID: roomID,
        }
    };
};

const initRound = async (roomID) => {
    const room = rooms.get(roomID);
    let players = room.players;

    // reset room data
    room.normalWord = undefined;
    room.undercoverWord = undefined;

    room.undercovers = [];
    room.misterWhite = undefined;

    // Reset player infos
    players.forEach(player => {
        player.hints = [];
        player.word = undefined;
        player.wordGuess = undefined;
        player.role = undefined;
        player.guess = undefined;
    });

    // Generate random words from database
    const words = await generateWords();
    room.normalWord = words.normal;
    room.undercoverWord = words.undercover;

    // Random undercover(s)
    do {
        let randomPlayer = players[Math.floor(Math.random() * players.length)];
        if (randomPlayer.role !== 'Undercover') {
            randomPlayer.role = 'Undercover';
            room.undercovers.push(randomPlayer);
        }
    } while (room.undercovers.length < room.settings.undercoverCount);
    // FIXME: Infinite loop if more undercover/misterwhite than player count

    // TODO: Make sure mister white doesn't start
    // Random mister white
    if (room.settings.misterWhite) {
        let randomPlayer = undefined;
        do {
            randomPlayer = players[Math.floor(Math.random() * players.length)];
            if (randomPlayer.role !== 'Undercover') {
                randomPlayer.role = 'MisterWhite';
                room.misterWhite = randomPlayer;
            }
        } while (randomPlayer.role === 'Undercover');
    }
};

const initPlayer = (player) => {
    player.username = player.request._query.username ?? ('Player-' + Math.floor(Math.random() * 100));
    player.avatar = player.request._query.avatar ?? 'man.png';
    player.hints = [];
    player.score = 0;
    player.guess = undefined;
    player.roomID = player.request._query.room || Math.random().toString(36).substring(2, 15);
    player.playerIndex = rooms.get(player.roomID) ? rooms.get(player.roomID).players.length : 0;
};

const addPlayerSettingsListeners = (player) => {
    player.on('setUsername', username => {
        player.username = username;
        player.to(player.roomID).emit('setUsername', { username: username, playerIndex: player.playerIndex });
    });
    player.on('setAvatar', avatar => {
        player.avatar = avatar;
        player.to(player.roomID).emit('setAvatar', { avatar: avatar, playerIndex: player.playerIndex });
    });
};

const addSettingsListeners = (owner) => {
    owner.on('setUndercoverCount', undercoverCount => {
        rooms.get(owner.roomID).settings.undercoverCount = undercoverCount;
        io.to(owner.roomID).emit('setUndercoverCount', undercoverCount);
    });
    owner.on('setMisterWhite', misterWhite => {
        rooms.get(owner.roomID).settings.misterWhite = misterWhite;
        io.to(owner.roomID).emit('setMisterWhite', misterWhite);
    });
    owner.on('setWordPerRoundCount', wordPerRoundCount => {
        rooms.get(owner.roomID).settings.wordPerRoundCount = wordPerRoundCount;
        io.to(owner.roomID).emit('setWordPerRoundCount', wordPerRoundCount);
    });
    owner.on('setRoundPerGameCount', roundPerGameCount => {
        rooms.get(owner.roomID).settings.roundPerGameCount = roundPerGameCount;
        io.to(owner.roomID).emit('setRoundPerGameCount', roundPerGameCount);
    });
    owner.on('startGame', async () => {
        startGame(owner.roomID);
        await startRound(owner.roomID);
    });
    owner.on('startRound', async () => {
        await startRound(owner.roomID);
    });
    owner.on('stopGame', () => {
        stopGame(owner.roomID);
    });
};

const stopGame = (roomID) => {
    const room = rooms.get(roomID);

    console.debug('Stopping game');
    room.players.forEach(player => {
        player.emit('stopGame');
    });
};

/**
 * Query randoms words from database
 * @return {{normal: string, undercover: string}}
 */
const generateWords = async () => {
    const randomWords = await words.getRandomWords();
    return {
        normal: randomWords.word1,
        undercover: randomWords.word2
    };
};
