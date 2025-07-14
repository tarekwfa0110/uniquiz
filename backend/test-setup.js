const { spawn } = require('child_process');
const path = require('path');

console.log('Testing setup...');

// Test Python script
console.log('\n1. Testing Python script...');
const pythonProcess = spawn('python', ['--version'], {
    cwd: path.join(__dirname),
    env: { ...process.env }
});

pythonProcess.stdout.on('data', (data) => {
    console.log('Python version:', data.toString().trim());
});

pythonProcess.stderr.on('data', (data) => {
    console.error('Python error:', data.toString());
});

pythonProcess.on('close', (code) => {
    if (code === 0) {
        console.log('✅ Python is available');
    } else {
        console.log('❌ Python is not available');
    }
});

// Test Node.js script
console.log('\n2. Testing Node.js script...');
const nodeProcess = spawn('node', ['--version'], {
    cwd: path.join(__dirname),
    env: { ...process.env }
});

nodeProcess.stdout.on('data', (data) => {
    console.log('Node.js version:', data.toString().trim());
});

nodeProcess.stderr.on('data', (data) => {
    console.error('Node.js error:', data.toString());
});

nodeProcess.on('close', (code) => {
    if (code === 0) {
        console.log('✅ Node.js is available');
    } else {
        console.log('❌ Node.js is not available');
    }
});

// Test if scripts exist
console.log('\n3. Testing script files...');
const fs = require('fs');

const pythonScriptPath = path.join(__dirname, 'scripts', 'main.py');
const groqScriptPath = path.join(__dirname, 'scripts', 'extractQuestionsGroq.js');

if (fs.existsSync(pythonScriptPath)) {
    console.log('✅ Python script exists:', pythonScriptPath);
} else {
    console.log('❌ Python script missing:', pythonScriptPath);
}

if (fs.existsSync(groqScriptPath)) {
    console.log('✅ Groq script exists:', groqScriptPath);
} else {
    console.log('❌ Groq script missing:', groqScriptPath);
}

console.log('\nSetup test completed!'); 