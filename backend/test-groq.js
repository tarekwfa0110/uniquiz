const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('Testing Groq JS script...');

// Create a test text file
const testText = `
Here are some sample multiple choice questions:

1. What is the capital of France?
   A) London
   B) Paris
   C) Berlin
   D) Madrid
   Answer: B

2. Which planet is closest to the Sun?
   A) Venus
   B) Earth
   C) Mercury
   D) Mars
   Answer: C

3. What is 2 + 2?
   A) 3
   B) 4
   C) 5
   D) 6
   Answer: B
`;

const testInputFile = path.join(__dirname, 'test_input.txt');
const testOutputFile = path.join(__dirname, 'test_output.json');

// Write test text to file
fs.writeFileSync(testInputFile, testText);

console.log('Test input file created:', testInputFile);

// Run the Groq script
const groqProcess = spawn('node', [
    path.join(__dirname, 'scripts/extractQuestionsGroq.js'),
    testInputFile,
    testOutputFile
], {
    cwd: __dirname,
    env: { ...process.env }
});

let stdout = '';
let stderr = '';

groqProcess.stdout.on('data', (data) => {
    stdout += data.toString();
    console.log('Groq stdout:', data.toString());
});

groqProcess.stderr.on('data', (data) => {
    stderr += data.toString();
    console.error('Groq stderr:', data.toString());
});

groqProcess.on('close', (code) => {
    console.log(`Groq process exited with code ${code}`);
    
    if (code === 0) {
        // Check if output file was created
        if (fs.existsSync(testOutputFile)) {
            try {
                const output = JSON.parse(fs.readFileSync(testOutputFile, 'utf8'));
                console.log('✅ Groq script worked! Output:', output);
                console.log(`Found ${output.length} questions`);
            } catch (e) {
                console.error('❌ Failed to parse output JSON:', e);
            }
        } else {
            console.error('❌ Output file was not created');
        }
    } else {
        console.error('❌ Groq script failed with error:', stderr);
    }
    
    // Clean up test files
    try {
        fs.unlinkSync(testInputFile);
        fs.unlinkSync(testOutputFile);
    } catch (e) {
        console.warn('Could not clean up test files:', e);
    }
}); 