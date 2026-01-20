const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const PORT = process.env.PORT || 3000;

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Game state management
const games = new Map();

class BingoGame {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = new Map();
    this.calledNumbers = [];
    this.currentNumber = null;
    this.gameState = 'waiting'; // waiting, playing, finished
    this.winner = null;
    this.callInterval = null;
  }

  addPlayer(socketId, playerName) {
    this.players.set(socketId, {
      id: socketId,
      name: playerName,
      card: this.generateBingoCard(),
      markedCells: new Set(),
    });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    if (this.players.size === 0) {
      this.stopGame();
    }
  }

  generateBingoCard() {
    const card = [];
    const ranges = [
      [1, 15],   // B
      [16, 30],  // I
      [31, 45],  // N
      [46, 60],  // G
      [61, 75],  // O
    ];

    for (let col = 0; col < 5; col++) {
      const numbers = [];
      const [min, max] = ranges[col];
      const available = Array.from({ length: max - min + 1 }, (_, i) => min + i);
      
      for (let row = 0; row < 5; row++) {
        if (col === 2 && row === 2) {
          // FREE space
          numbers.push('FREE');
        } else {
          const randomIndex = Math.floor(Math.random() * available.length);
          numbers.push(available.splice(randomIndex, 1)[0]);
        }
      }
      card.push(numbers);
    }

    return card;
  }

  startGame() {
    if (this.gameState !== 'waiting') return;
    
    this.gameState = 'playing';
    this.calledNumbers = [];
    this.winner = null;
    
    // Call a number every 5 seconds
    this.callInterval = setInterval(() => {
      this.callNumber();
    }, 5000);

    // Call first number immediately
    this.callNumber();
  }

  callNumber() {
    const availableNumbers = Array.from({ length: 75 }, (_, i) => i + 1)
      .filter(num => !this.calledNumbers.includes(num));

    if (availableNumbers.length === 0) {
      this.stopGame();
      return null;
    }

    const randomIndex = Math.floor(Math.random() * availableNumbers.length);
    const number = availableNumbers[randomIndex];
    
    this.calledNumbers.push(number);
    this.currentNumber = number;
    
    return number;
  }

  stopGame() {
    if (this.callInterval) {
      clearInterval(this.callInterval);
      this.callInterval = null;
    }
  }

  checkWin(socketId) {
    const player = this.players.get(socketId);
    if (!player) return false;

    const { card, markedCells } = player;
    
    // Always mark FREE space
    const freeIndex = 2 * 5 + 2; // row 2, col 2
    markedCells.add(freeIndex);

    // Check rows
    for (let row = 0; row < 5; row++) {
      let count = 0;
      for (let col = 0; col < 5; col++) {
        const index = row * 5 + col;
        if (markedCells.has(index)) count++;
      }
      if (count === 5) return true;
    }

    // Check columns
    for (let col = 0; col < 5; col++) {
      let count = 0;
      for (let row = 0; row < 5; row++) {
        const index = row * 5 + col;
        if (markedCells.has(index)) count++;
      }
      if (count === 5) return true;
    }

    // Check diagonal (top-left to bottom-right)
    let diagCount1 = 0;
    for (let i = 0; i < 5; i++) {
      const index = i * 5 + i;
      if (markedCells.has(index)) diagCount1++;
    }
    if (diagCount1 === 5) return true;

    // Check diagonal (top-right to bottom-left)
    let diagCount2 = 0;
    for (let i = 0; i < 5; i++) {
      const index = i * 5 + (4 - i);
      if (markedCells.has(index)) diagCount2++;
    }
    if (diagCount2 === 5) return true;

    return false;
  }

  getState() {
    return {
      roomId: this.roomId,
      playerCount: this.players.size,
      calledNumbers: this.calledNumbers,
      currentNumber: this.currentNumber,
      gameState: this.gameState,
      winner: this.winner,
    };
  }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on('joinGame', ({ roomId, playerName }) => {
    // Create game room if it doesn't exist
    if (!games.has(roomId)) {
      games.set(roomId, new BingoGame(roomId));
    }

    const game = games.get(roomId);
    game.addPlayer(socket.id, playerName || `Player ${game.players.size + 1}`);
    
    socket.join(roomId);
    socket.roomId = roomId;

    const player = game.players.get(socket.id);

    // Send player their card
    socket.emit('gameJoined', {
      card: player.card,
      playerName: player.name,
      gameState: game.getState(),
    });

    // Notify all players in room
    io.to(roomId).emit('playerJoined', {
      playerName: player.name,
      playerCount: game.players.size,
    });

    console.log(`${player.name} joined room ${roomId}`);
  });

  socket.on('startGame', () => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const game = games.get(roomId);
    if (!game) return;

    game.startGame();
    io.to(roomId).emit('gameStarted', game.getState());
    console.log(`Game started in room ${roomId}`);
  });

  socket.on('markCell', ({ row, col }) => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const game = games.get(roomId);
    if (!game) return;

    const player = game.players.get(socket.id);
    if (!player) return;

    const index = row * 5 + col;
    const cellValue = player.card[col][row];

    // Check if the number has been called or it's the FREE space
    if (cellValue === 'FREE' || game.calledNumbers.includes(cellValue)) {
      player.markedCells.add(index);
      socket.emit('cellMarked', { row, col });
    }
  });

  socket.on('claimBingo', () => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const game = games.get(roomId);
    if (!game || game.gameState !== 'playing') return;

    const player = game.players.get(socket.id);
    if (!player) return;

    const isWinner = game.checkWin(socket.id);

    if (isWinner) {
      game.gameState = 'finished';
      game.winner = player.name;
      game.stopGame();

      io.to(roomId).emit('gameWon', {
        winner: player.name,
        winningCard: player.card,
        markedCells: Array.from(player.markedCells),
      });

      console.log(`${player.name} won in room ${roomId}!`);
    } else {
      socket.emit('invalidBingo', { message: 'Not a valid Bingo!' });
    }
  });

  socket.on('newGame', () => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const game = games.get(roomId);
    if (!game) return;

    // Reset game
    game.stopGame();
    game.calledNumbers = [];
    game.currentNumber = null;
    game.gameState = 'waiting';
    game.winner = null;

    // Generate new cards for all players
    game.players.forEach((player) => {
      player.card = game.generateBingoCard();
      player.markedCells = new Set();
    });

    // Notify all players
    game.players.forEach((player, socketId) => {
      io.to(socketId).emit('gameReset', {
        card: player.card,
        gameState: game.getState(),
      });
    });

    console.log(`Game reset in room ${roomId}`);
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId) return;

    const game = games.get(roomId);
    if (!game) return;

    const player = game.players.get(socket.id);
    const playerName = player ? player.name : 'Unknown';

    game.removePlayer(socket.id);

    if (game.players.size === 0) {
      games.delete(roomId);
      console.log(`Room ${roomId} deleted (no players)`);
    } else {
      io.to(roomId).emit('playerLeft', {
        playerName,
        playerCount: game.players.size,
      });
    }

    console.log(`${playerName} left room ${roomId}`);
  });
});

// Broadcast called numbers
setInterval(() => {
  games.forEach((game) => {
    if (game.gameState === 'playing' && game.currentNumber) {
      io.to(game.roomId).emit('numberCalled', {
        number: game.currentNumber,
        calledNumbers: game.calledNumbers,
      });
    }
  });
}, 100);

server.listen(PORT, () => {
  console.log(`🎮 Bingo server running on http://localhost:${PORT}`);
};