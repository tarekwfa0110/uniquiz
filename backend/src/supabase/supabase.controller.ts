import { Controller, Get, UseGuards, Req, Post, UploadedFile, UseInterceptors, Param, Body, Delete, UploadedFiles, Put } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { SupabaseService } from './supabase.service';
import { ConfigService } from '@nestjs/config';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as os from 'os';

@Controller('supabase')
export class SupabaseController {
    constructor(
        private readonly supabaseService: SupabaseService,
        private readonly configService: ConfigService
    ) {}

    @Get('data')
    async getData() {
        const supabase = this.supabaseService.getClient();
        const { data, error } = await supabase.from('test').select('*');
        return { data, error };
    }

    @Post('upload-pdf')
    @UseGuards(SupabaseAuthGuard)
    @UseInterceptors(FileInterceptor('file'))
    async uploadPdf(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
        try {
            const userId = req.user.sub;
            const supabase = this.supabaseService.getClient();

            if (!file) {
                return { error: 'No file uploaded' };
            }

            if (file.mimetype !== 'application/pdf') {
                return { error: 'Only PDF files are allowed' };
            }

            // First, let's check what buckets are available
            const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets();
            
            if (bucketsError) {
                return { error: 'Failed to access storage', details: bucketsError.message };
            }

            // Check if 'pdfs' bucket exists
            const pdfsBucket = buckets?.find(b => b.name === 'pdfs');
            if (!pdfsBucket) {
                const { data: newBucket, error: createError } = await supabase.storage.createBucket('pdfs', {
                    public: false,
                    allowedMimeTypes: ['application/pdf'],
                    fileSizeLimit: 52428800 // 50MB
                });

                if (createError) {
                    return { error: 'Failed to create storage bucket', details: createError.message };
                }
            }

            // Upload to Supabase Storage
            const bucket = 'pdfs';
            const filePath = `${userId}/${Date.now()}_${file.originalname}`;

            const { data: uploadData, error: uploadError } = await supabase.storage
                .from(bucket)
                .upload(filePath, file.buffer, {
                    contentType: file.mimetype,
                    upsert: false,
                });

            if (uploadError) {
                return { error: 'Failed to upload file', details: uploadError.message };
            }

            // Save metadata to database
            const { data: dbData, error: dbError } = await supabase
                .from('pdf_uploads')
                .insert([
                    {
                        user_id: userId,
                        file_name: file.originalname,
                        storage_path: filePath,
                        status: 'uploaded',
                        created_at: new Date().toISOString(),
                    },
                ])
                .select();

            if (dbError) {
                return { error: 'Failed to save metadata', details: dbError.message };
            }

            const pdfId = dbData?.[0]?.id;

            // Automatically trigger processing
            this.processPdfInBackground(req, pdfId).catch(error => {
            });

            return {
                message: 'PDF uploaded successfully! Processing started in background.',
                file: {
                    name: file.originalname,
                    size: file.size,
                    path: filePath,
                    id: pdfId
                },
                user: {
                    id: userId,
                    email: req.user.email
                },
                processing: true
            };

        } catch (error) {
            return { error: 'Internal server error', details: error.message };
        }
    }

    @Get('test-connection')
    async testSupabaseConnection() {
        try {
            const supabase = this.supabaseService.getClient();
            
            // Test basic connection by querying a simple table
            const { data, error } = await supabase
                .from('pdf_uploads')
                .select('count')
                .limit(1);
            
            if (error) {
                return {
                    status: 'error',
                    message: 'Failed to connect to Supabase',
                    error: error.message,
                    code: error.code
                };
            }
            
            return {
                status: 'success',
                message: 'Supabase connection successful',
                data: data
            };
            
        } catch (error) {
            return {
                status: 'error',
                message: 'Unexpected error',
                error: error.message
            };
        }
    }

    @Get('my-pdfs')
    @UseGuards(SupabaseAuthGuard)
    async getUserPdfs(@Req() req: any) {
        try {
            const userId = req.user.sub;
            const supabase = this.supabaseService.getClient();

            const { data: pdfs, error } = await supabase
                .from('pdf_uploads')
                .select('*')
                .eq('user_id', userId)
                .order('created_at', { ascending: false });

            if (error) {
                return { error: 'Failed to fetch PDFs', details: error.message };
            }

            return {
                message: 'PDFs fetched successfully',
                count: pdfs?.length || 0,
                pdfs: pdfs || []
            };

        } catch (error) {
            return { error: 'Internal server error', details: error.message };
        }
    }

    @Get('download/:id')
    @UseGuards(SupabaseAuthGuard)
    async downloadPdf(@Req() req: any, @Param('id') id: string) {
        try {
            const userId = req.user.sub;
            const supabase = this.supabaseService.getClient();

            // First, verify the PDF belongs to the user
            const { data: pdf, error: fetchError } = await supabase
                .from('pdf_uploads')
                .select('*')
                .eq('id', id)
                .eq('user_id', userId)
                .single();

            if (fetchError || !pdf) {
                return { error: 'PDF not found or access denied' };
            }

            // Get download URL from Supabase Storage
            const { data: downloadData, error: downloadError } = await supabase.storage
                .from('pdfs')
                .createSignedUrl(pdf.storage_path, 60); // 60 seconds expiry

            if (downloadError) {
                return { error: 'Failed to generate download link', details: downloadError.message };
            }

            return {
                message: 'Download link generated',
                downloadUrl: downloadData.signedUrl,
                fileName: pdf.file_name,
                expiresIn: 60
            };

        } catch (error) {
            return { error: 'Internal server error', details: error.message };
        }
    }

    @Post('process-pdf/:pdfId')
    @UseGuards(SupabaseAuthGuard)
    async processPdf(@Req() req: any, @Param('pdfId') pdfId: string) {
        try {
            const userId = req.user.sub;
            const supabase = this.supabaseService.getClient();

            // 1. Find the PDF record
            const { data: pdf, error: fetchError } = await supabase
                .from('pdf_uploads')
                .select('*')
                .eq('id', pdfId)
                .eq('user_id', userId)
                .single();
            if (fetchError || !pdf) {
                return { error: 'PDF not found or access denied' };
            }

            // 1a. Set status to 'processing'
            await supabase
                .from('pdf_uploads')
                .update({ status: 'processing' })
                .eq('id', pdfId)
                .eq('user_id', userId);

            // 2. Download the PDF from Supabase Storage
            const { data: downloadData, error: downloadError } = await supabase.storage
                .from('pdfs')
                .download(pdf.storage_path);
            if (downloadError || !downloadData) {
                // Set status to 'failed'
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                return { error: 'Failed to download PDF from storage', details: downloadError?.message };
            }

            // 3. Save the PDF to a temp file
            const tempDir = os.tmpdir();
            const tempBase = `${pdfId}_${Date.now()}`;
            const tempPath = path.join(tempDir, `${tempBase}.pdf`);
            const tempOutputTxt = path.join(tempDir, `${tempBase}_output.txt`);
            const tempOutputJson = path.join(tempDir, `${tempBase}_questions.json`);
            const buffer = Buffer.from(await downloadData.arrayBuffer());
            fs.writeFileSync(tempPath, buffer);

            // 4. Run the Python extraction pipeline
            let pythonExitCode = 0;
            let pythonOutput = '';
            let pythonError = '';
            
            try {
                const { spawn } = require('child_process');
                const pythonProcess = spawn('python', [
                    path.join(__dirname, '../../scripts/main.py'),
                    tempPath,
                    tempOutputTxt
                ], {
                    cwd: path.join(__dirname, '../../'),
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
                });

                // Capture stdout and stderr
                pythonProcess.stdout.on('data', (data: Buffer) => {
                    pythonOutput += data.toString();
                });

                pythonProcess.stderr.on('data', (data: Buffer) => {
                    pythonError += data.toString();
                });

                // Wait for Python process to complete
                await new Promise<void>((resolve, reject) => {
                    pythonProcess.on('close', (code: number) => {
                        pythonExitCode = code;
                        resolve();
                    });
                    pythonProcess.on('error', (err: Error) => {
                        reject(err);
                    });
                });

            } catch (err: any) {
                // Set status to 'failed'
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                return { error: 'Failed to run Python extraction script', details: err.message };
            }

            // 5. Handle Python script exit codes
            if (pythonExitCode !== 0) {
                let errorMessage = 'Python extraction failed';
                let errorDetails = '';
                
                switch (pythonExitCode) {
                    case 3:
                        errorMessage = 'OCR processing failed';
                        errorDetails = 'The PDF requires OCR but the OCR process failed. Please try a higher quality scan.';
                        break;
                    case 4:
                        errorMessage = 'OCR quality issue';
                        errorDetails = 'OCR extracted text is too short or unclear. Please try a higher quality scan.';
                        break;
                    case 5:
                        errorMessage = 'Tesseract OCR not available';
                        errorDetails = 'OCR is required but Tesseract is not installed. Please install Tesseract OCR.';
                        break;
                    case 6:
                        errorMessage = 'Text extraction failed';
                        errorDetails = 'Could not extract meaningful text from the PDF. The PDF may be empty or scanned as images.';
                        break;
                    case 7:
                        errorMessage = 'PDF file not found';
                        errorDetails = 'The PDF file could not be located.';
                        break;
                    case 8:
                        errorMessage = 'File save error';
                        errorDetails = 'Failed to save extracted text to file.';
                        break;
                    case 9:
                        errorMessage = 'Groq API error';
                        errorDetails = 'Failed to call Groq API for question extraction.';
                        break;
                    case 10:
                        errorMessage = 'No text extracted';
                        errorDetails = 'No text was extracted from the PDF file.';
                        break;
                    default:
                        errorDetails = `Python script exited with code ${pythonExitCode}`;
                }

                // Set status to 'failed'
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);

                return { 
                    error: errorMessage, 
                    details: errorDetails,
                    pythonOutput,
                    pythonError
                };
            }

            // 6. Check if text file was created
            if (!fs.existsSync(tempOutputTxt) || fs.statSync(tempOutputTxt).size === 0) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                return { 
                    error: 'No text extracted from PDF', 
                    details: 'The Python script did not generate any text output.',
                    pythonOutput,
                    pythonError
                };
            }

            // 7. Run Groq JS script for question extraction
            let groqExitCode = 0;
            let groqOutput = '';
            let groqError = '';
            
            try {
                const { spawn } = require('child_process');
                const groqProcess = spawn('node', [
                    path.join(__dirname, '../../scripts/extractQuestionsGroq.js'),
                    tempOutputTxt,
                    tempOutputJson
                ], {
                    cwd: path.join(__dirname, '../../'),
                    env: { ...process.env }
                });

                // Capture stdout and stderr
                groqProcess.stdout.on('data', (data: Buffer) => {
                    groqOutput += data.toString();
                });

                groqProcess.stderr.on('data', (data: Buffer) => {
                    groqError += data.toString();
                });

                // Wait for Groq process to complete
                await new Promise<void>((resolve, reject) => {
                    groqProcess.on('close', (code: number) => {
                        groqExitCode = code;
                        resolve();
                    });
                    groqProcess.on('error', (err: Error) => {
                        reject(err);
                    });
                });

            } catch (err: any) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                return { error: 'Failed to run Groq question extraction', details: err.message };
            }

            // 8. Check Groq script output
            if (groqExitCode !== 0 || !fs.existsSync(tempOutputJson) || fs.statSync(tempOutputJson).size === 0) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                return { 
                    error: 'Question extraction failed', 
                    details: 'Failed to extract questions from the PDF text.',
                    groqOutput,
                    groqError
                };
            }

            // 9. Parse questions from JSON
            let questions: any[] = [];
            try {
                const questionsData = JSON.parse(fs.readFileSync(tempOutputJson, 'utf8'));
                questions = Array.isArray(questionsData) ? questionsData : [];
            } catch (err: any) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                return { 
                    error: 'Failed to parse questions JSON', 
                    details: err.message,
                    groqOutput
                };
            }

            if (questions.length === 0) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                return { 
                    error: 'No questions found', 
                    details: 'No questions were extracted from the PDF.',
                    groqOutput
                };
            }

            // 10. Create question set
            const questionSetName = `Extracted from ${pdf.file_name} (${new Date().toLocaleString()})`;
            const { data: questionSetData, error: questionSetError } = await supabase
                .from('question_sets')
                .insert([
                    {
                user_id: userId,
                        name: questionSetName,
                        source_pdf_id: pdfId,
                        created_at: new Date().toISOString(),
                    },
                ])
                .select();

            if (questionSetError) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                return { error: 'Failed to create question set', details: questionSetError.message };
            }

            const questionSetId = questionSetData?.[0]?.id;

            // 11. Insert questions into the database
            const questionRows = questions.map((q: any, index: number) => ({
                question_set_id: questionSetId,
                question_text: q.question,
                options: q.options,
                answer: q.answer,
                created_at: new Date().toISOString(),
            }));

            const { data: insertedQuestions, error: insertError } = await supabase
                .from('questions')
                .insert(questionRows)
                .select();

            if (insertError) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                return { error: 'Failed to save questions', details: insertError.message };
            }

            // 12. Set status to 'processed'
            await supabase
                .from('pdf_uploads')
                .update({ status: 'processed' })
                .eq('id', pdfId)
                .eq('user_id', userId);

            // 13. Clean up temp files
            try {
                fs.unlinkSync(tempPath);
                fs.unlinkSync(tempOutputTxt);
                fs.unlinkSync(tempOutputJson);
            } catch (e) {
            }

            return {
                message: 'Questions extracted and saved successfully',
                count: insertedQuestions?.length || 0,
                questionSetId,
                questions: insertedQuestions || []
            };

        } catch (error: any) {
            // Set status to 'failed' on any unexpected error
            try {
                const userId = req.user.sub;
                const supabase = this.supabaseService.getClient();
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
            } catch (e) {
                // Ignore errors in error handler
            }
            return { error: 'Internal server error', details: error.message };
        }
    }

    private async processPdfInBackground(req: any, pdfId: string) {
        try {
            // Call the processPdf method with the same logic but without returning response
            const userId = req.user.sub;
            const supabase = this.supabaseService.getClient();

            // 1. Find the PDF record
            const { data: pdf, error: fetchError } = await supabase
                .from('pdf_uploads')
                .select('*')
                .eq('id', pdfId)
                .eq('user_id', userId)
                .single();
            if (fetchError || !pdf) {
                throw new Error('PDF not found or access denied');
            }

            // 2. Download the PDF from Supabase Storage
            const { data: downloadData, error: downloadError } = await supabase.storage
                .from('pdfs')
                .download(pdf.storage_path);
            if (downloadError || !downloadData) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                throw new Error('Failed to download PDF from storage');
            }

            // 3. Save the PDF to a temp file
            const tempDir = os.tmpdir();
            const tempBase = `${pdfId}_${Date.now()}`;
            const tempPath = path.join(tempDir, `${tempBase}.pdf`);
            const tempOutputTxt = path.join(tempDir, `${tempBase}_output.txt`);
            const tempOutputJson = path.join(tempDir, `${tempBase}_questions.json`);
            const buffer = Buffer.from(await downloadData.arrayBuffer());
            fs.writeFileSync(tempPath, buffer);

            // 4. Run the Python extraction pipeline
            let pythonExitCode = 0;
            let pythonOutput = '';
            let pythonError = '';
            
            try {
                const { spawn } = require('child_process');
                const pythonProcess = spawn('python', [
                    path.join(__dirname, '../../scripts/main.py'),
                    tempPath,
                    tempOutputTxt
                ], {
                    cwd: path.join(__dirname, '../../'),
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
                });

                // Capture stdout and stderr
                pythonProcess.stdout.on('data', (data: Buffer) => {
                    pythonOutput += data.toString();
                });

                pythonProcess.stderr.on('data', (data: Buffer) => {
                    pythonError += data.toString();
                });

                // Wait for Python process to complete
                await new Promise<void>((resolve, reject) => {
                    pythonProcess.on('close', (code: number) => {
                        pythonExitCode = code;
                        resolve();
                    });
                    pythonProcess.on('error', (err: Error) => {
                        reject(err);
                    });
                });

            } catch (err: any) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                throw new Error('Failed to run Python extraction script');
            }

            // 5. Handle Python script exit codes
            if (pythonExitCode !== 0) {
                let errorMessage = 'Python extraction failed';
                
                switch (pythonExitCode) {
                    case 3:
                        errorMessage = 'OCR processing failed';
                        break;
                    case 4:
                        errorMessage = 'OCR quality issue';
                        break;
                    case 5:
                        errorMessage = 'Tesseract OCR not available';
                        break;
                    case 6:
                        errorMessage = 'Text extraction failed';
                        break;
                    case 7:
                        errorMessage = 'PDF file not found';
                        break;
                    case 8:
                        errorMessage = 'File save error';
                        break;
                    case 9:
                        errorMessage = 'Groq API error';
                        break;
                    case 10:
                        errorMessage = 'No text extracted';
                        break;
                    default:
                        errorMessage = `Python script exited with code ${pythonExitCode}`;
                }

                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                throw new Error(errorMessage);
            }

            // 6. Check if text file was created
            if (!fs.existsSync(tempOutputTxt) || fs.statSync(tempOutputTxt).size === 0) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                throw new Error('No text extracted from PDF');
            }

            // 7. Run Groq JS script for question extraction
            let groqExitCode = 0;
            let groqOutput = '';
            let groqError = '';
            
            try {
                const { spawn } = require('child_process');
                const groqProcess = spawn('node', [
                    path.join(__dirname, '../../scripts/extractQuestionsGroq.js'),
                    tempOutputTxt,
                    tempOutputJson
                ], {
                    cwd: path.join(__dirname, '../../'),
                    env: { ...process.env }
                });

                // Capture stdout and stderr
                groqProcess.stdout.on('data', (data: Buffer) => {
                    groqOutput += data.toString();
                });

                groqProcess.stderr.on('data', (data: Buffer) => {
                    groqError += data.toString();
                });

                // Wait for Groq process to complete
                await new Promise<void>((resolve, reject) => {
                    groqProcess.on('close', (code: number) => {
                        groqExitCode = code;
                        resolve();
                    });
                    groqProcess.on('error', (err: Error) => {
                        reject(err);
                    });
                });

            } catch (err: any) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                throw new Error('Failed to run Groq question extraction');
            }

            // 8. Check Groq script output
            if (groqExitCode !== 0 || !fs.existsSync(tempOutputJson) || fs.statSync(tempOutputJson).size === 0) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                throw new Error('Question extraction failed');
            }

            // 9. Parse questions from JSON
            let questions: any[] = [];
            try {
                const questionsData = JSON.parse(fs.readFileSync(tempOutputJson, 'utf8'));
                questions = Array.isArray(questionsData) ? questionsData : [];
            } catch (err: any) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                throw new Error('Failed to parse questions JSON');
            }

            if (questions.length === 0) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                throw new Error('No questions found');
            }

            // 10. Create question set
            const questionSetName = `Extracted from ${pdf.file_name} (${new Date().toLocaleString()})`;
            const { data: questionSetData, error: questionSetError } = await supabase
                .from('question_sets')
                .insert([
                    {
                        user_id: userId,
                        name: questionSetName,
                        source_pdf_id: pdfId,
                        created_at: new Date().toISOString(),
                    },
                ])
                .select();

            if (questionSetError) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                throw new Error('Failed to create question set');
            }

            const questionSetId = questionSetData?.[0]?.id;

            // 11. Insert questions into the database
            const questionRows = questions.map((q: any, index: number) => ({
                question_set_id: questionSetId,
                question_text: q.question,
                options: q.options,
                answer: q.answer,
                created_at: new Date().toISOString(),
            }));

            const { data: insertedQuestions, error: insertError } = await supabase
                .from('questions')
                .insert(questionRows)
                .select();

            if (insertError) {
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
                throw new Error('Failed to save questions');
            }

            // 12. Set status to 'processed'
            await supabase
                .from('pdf_uploads')
                .update({ status: 'processed' })
                .eq('id', pdfId)
                .eq('user_id', userId);

            // 13. Clean up temp files
            try {
                fs.unlinkSync(tempPath);
                fs.unlinkSync(tempOutputTxt);
                fs.unlinkSync(tempOutputJson);
            } catch (e) {
            }

        } catch (error: any) {
            // Set status to 'failed' on any unexpected error
            try {
                const userId = req.user.sub;
                const supabase = this.supabaseService.getClient();
                await supabase
                    .from('pdf_uploads')
                    .update({ status: 'failed' })
                    .eq('id', pdfId)
                    .eq('user_id', userId);
            } catch (e) {
                // Ignore errors in error handler
            }
        }
    }

    @Get('pdf-questions/:pdfId')
    @UseGuards(SupabaseAuthGuard)
    async getPdfQuestions(@Req() req: any, @Param('pdfId') pdfId: string) {
        try {
            const userId = req.user.sub;
            const supabase = this.supabaseService.getClient();

            // First, find the question set for this PDF
            const { data: questionSet, error: setError } = await supabase
                .from('question_sets')
                .select('id')
                .eq('source_pdf_id', pdfId)
                .eq('user_id', userId)
                .single();

            if (setError || !questionSet) {
                return { 
                    message: 'No questions found for this PDF',
                    count: 0,
                    questions: []
                };
            }

            // Fetch all questions for this question set
            const { data: questions, error } = await supabase
                .from('questions')
                .select('*')
                .eq('question_set_id', questionSet.id)
                .order('created_at', { ascending: true });

            if (error) {
                return { error: 'Failed to fetch questions', details: error.message };
            }

            return {
                message: 'Questions fetched successfully',
                count: questions?.length || 0,
                questions: questions || []
            };
        } catch (error) {
            return { error: 'Internal server error', details: error.message };
        }
    }

    @Get('question-sets')
    @UseGuards(SupabaseAuthGuard)
    async getQuestionSets(@Req() req: any) {
        const userId = req.user.sub;
        const supabase = this.supabaseService.getClient();
        const { data, error } = await supabase
            .from('question_sets')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        if (error) return { error: error.message };
        return { questionSets: data };
    }

    @Get('question-sets/:id/questions')
    @UseGuards(SupabaseAuthGuard)
    async getQuestionsForSet(@Req() req: any, @Param('id') id: string) {
        const userId = req.user.sub;
        const supabase = this.supabaseService.getClient();
        // Ensure the set belongs to the user
        const { data: set, error: setError } = await supabase
            .from('question_sets')
            .select('id')
            .eq('id', id)
            .eq('user_id', userId)
            .single();
        if (setError || !set) return { error: 'Not found or unauthorized' };
        const { data, error } = await supabase
            .from('questions')
            .select('*')
            .eq('question_set_id', id)
            .order('created_at', { ascending: true });
        if (error) return { error: error.message };
        return { questions: data };
    }

    @Delete('question-sets/:id')
    @UseGuards(SupabaseAuthGuard)
    async deleteQuestionSet(@Req() req: any, @Param('id') id: string) {
        try {
            const userId = req.user.sub;
            const supabase = this.supabaseService.getClient();
            
            // Ensure the set belongs to the user
            const { data: set, error: setError } = await supabase
                .from('question_sets')
                .select('id')
                .eq('id', id)
                .eq('user_id', userId)
                .single();
            
            if (setError || !set) {
                return { error: 'Question set not found or unauthorized' };
            }

            // Delete all questions in the set first
            const { error: questionsError } = await supabase
                .from('questions')
                .delete()
                .eq('question_set_id', id);

            if (questionsError) {
                return { error: 'Failed to delete questions' };
            }

            // Delete the question set
            const { error: setDeleteError } = await supabase
                .from('question_sets')
                .delete()
                .eq('id', id)
                .eq('user_id', userId);

            if (setDeleteError) {
                return { error: 'Failed to delete question set' };
            }

            return { message: 'Question set deleted successfully' };
        } catch (error: any) {
            return { error: 'Internal server error', details: error.message };
        }
    }

    @Post('quiz-results')
    @UseGuards(SupabaseAuthGuard)
    async saveQuizResult(@Req() req: any, @Body() body: any) {
        const userId = req.user.sub;
        const { question_set_id, score, answers } = body;
        const supabase = this.supabaseService.getClient();
        const { data, error } = await supabase
            .from('quiz_results')
            .insert([
                {
                    user_id: userId,
                    question_set_id,
                    score,
                    answers,
                    created_at: new Date().toISOString(),
                },
            ])
            .select();
        if (error) return { error: error.message };
        return { result: data?.[0] };
    }

    @Post('bookmarks')
    @UseGuards(SupabaseAuthGuard)
    async addBookmark(@Req() req: any, @Body() body: any) {
        const userId = req.user.sub;
        const { question_id } = body;
        const supabase = this.supabaseService.getClient();
        const { data, error } = await supabase
            .from('bookmarks')
            .insert([
                {
                    user_id: userId,
                    question_id,
                    created_at: new Date().toISOString(),
                },
            ])
            .select();
        if (error) return { error: error.message };
        return { bookmark: data?.[0] };
    }

    @Delete('bookmarks/:id')
    @UseGuards(SupabaseAuthGuard)
    async removeBookmark(@Req() req: any, @Param('id') id: string) {
        const userId = req.user.sub;
        const supabase = this.supabaseService.getClient();
        const { error } = await supabase
            .from('bookmarks')
            .delete()
            .eq('id', id)
            .eq('user_id', userId);
        if (error) return { error: error.message };
        return { success: true };
    }

    @Get('bookmarks')
    @UseGuards(SupabaseAuthGuard)
    async getBookmarks(@Req() req: any) {
        const userId = req.user.sub;
        const supabase = this.supabaseService.getClient();
        // Join bookmarks with questions
        const { data, error } = await supabase
            .from('bookmarks')
            .select('id, created_at, question:questions(*)')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        if (error) return { error: error.message };
        return { bookmarks: data };
    }

    @Post('upload-question-group')
    @UseGuards(SupabaseAuthGuard)
    @UseInterceptors(FilesInterceptor('files'))
    async uploadQuestionGroup(@UploadedFiles() files: Express.Multer.File[], @Req() req: any, @Body() body: any) {
        const groupName = body.group_name || 'Untitled Group';
        const userId = req.user.sub;
        const supabase = this.supabaseService.getClient();

        // Create the question set
        const { data: questionSetData, error: questionSetError } = await supabase
            .from('question_sets')
            .insert([
                {
                    user_id: userId,
                    name: groupName,
                    created_at: new Date().toISOString(),
                },
            ])
            .select();
        if (questionSetError) {
            return { error: 'Failed to create question set', details: questionSetError.message };
        }
        const questionSetId = questionSetData?.[0]?.id;

        // Only process the first file for now
        if (!files || files.length === 0) {
            return { error: 'No files uploaded' };
        }
        const file = files[0];
        const tempDir = os.tmpdir();
        const tempPdfPath = path.join(tempDir, `${Date.now()}_${file.originalname}`);
        const tempOutputPath = tempPdfPath.replace(/\.pdf$/i, '_output.txt');
        const tempQuestionsPath = path.join(path.dirname(tempPdfPath), 'questions_from_groq.json');
        // Save PDF to temp
        fs.writeFileSync(tempPdfPath, file.buffer);

        // Call main.py as a subprocess
        const pythonProcess = spawn('python', [
            path.join(__dirname, '../../scripts/main.py'),
            tempPdfPath,
            tempOutputPath,
        ], {
            env: { ...process.env },
        });

        let pythonStdout = '';
        let pythonStderr = '';
        pythonProcess.stdout.on('data', (data) => { pythonStdout += data.toString(); });
        pythonProcess.stderr.on('data', (data) => { pythonStderr += data.toString(); });

        const exitCode: number = await new Promise((resolve) => {
            pythonProcess.on('close', resolve);
        });

        if (exitCode !== 0) {
            return { error: 'Failed to extract questions', details: pythonStderr };
        }

        // Read questions_from_groq.json
        let allQuestions: any[] = [];
        try {
            const questionsRaw = fs.readFileSync(tempQuestionsPath, 'utf-8');
            allQuestions = JSON.parse(questionsRaw);
        } catch (e) {
            return { error: 'Failed to read extracted questions' };
        }

        // Insert questions into questions table
        const questionRows = allQuestions.map((q: any) => ({
            question_set_id: questionSetId,
            question_text: q.question,
            options: q.options,
            answer: q.answer,
            created_at: new Date().toISOString(),
        }));
        if (questionRows.length > 0) {
            const { error: insertQErr } = await supabase
                .from('questions')
                .insert(questionRows);
            if (insertQErr) {
                return { error: 'Failed to save questions', details: insertQErr.message };
            }
        }

        // Clean up temp files
        try {
            fs.unlinkSync(tempPdfPath);
            fs.unlinkSync(tempOutputPath);
            fs.unlinkSync(tempQuestionsPath);
        } catch {}

        return { question_set_id: questionSetId };
    }

    @Get('profile')
    @UseGuards(SupabaseAuthGuard)
    async getProfile(@Req() req: any) {
        const userId = req.user.sub;
        const supabase = this.supabaseService.getClient();
        // Try to fetch the profile
        let { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .single();
        if (error && error.code !== 'PGRST116') { // Not found is not a fatal error
            return { error: error.message };
        }
        // If not found, create a new profile row
        if (!profile) {
            const { data: newProfile, error: insertError } = await supabase
                .from('profiles')
                .insert([{ id: userId }])
                .select()
                .single();
            if (insertError) return { error: insertError.message };
            profile = newProfile;
        }
        return { profile };
    }

    @Put('profile')
    @UseGuards(SupabaseAuthGuard)
    async updateProfile(@Req() req: any, @Body() body: any) {
      const userId = req.user.sub;
      const supabase = this.supabaseService.getClient();
      const { display_name, age, bio, avatar_url } = body;
      const { data, error } = await supabase
        .from('profiles')
        .update({
          display_name,
          age,
          bio,
          avatar_url,
        })
        .eq('id', userId)
        .select()
        .single();
      if (error) return { error: error.message };
      return { profile: data };
    }
}