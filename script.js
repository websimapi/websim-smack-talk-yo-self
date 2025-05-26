class SmackTalkApp {
    constructor() {
        this.isRecording = false;
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.conversationHistory = this.loadConversationHistory();
        this.voiceSample = null;
        this.userSpeakingStyle = this.loadSpeakingStyle();
        this.maxRetries = 3;
        this.baseRetryDelay = 1000; // 1 second
        this.liveRecognition = null;
        this.finalTranscript = '';
        this.lastInterimTranscript = '';
        
        this.initializeElements();
        this.setupEventListeners();
        this.updateConversationCount();
    }

    initializeElements() {
        this.recordBtn = document.getElementById('recordBtn');
        this.recordingIndicator = document.getElementById('recordingIndicator');
        this.messageContainer = document.getElementById('messageContainer');
        this.loadingOverlay = document.getElementById('loadingOverlay');
        this.loadingText = document.getElementById('loadingText');
        this.clearHistoryBtn = document.getElementById('clearHistory');
        this.conversationCountEl = document.getElementById('conversationCount');
        this.audioVisualizer = document.getElementById('audioVisualizer');
        this.liveTranscription = document.getElementById('liveTranscription');
        this.transcriptionText = document.getElementById('transcriptionText');
    }

    setupEventListeners() {
        this.recordBtn.addEventListener('click', () => this.toggleRecording());
        this.clearHistoryBtn.addEventListener('click', () => this.clearHistory());
    }

    async toggleRecording() {
        if (!this.isRecording) {
            await this.startRecording();
        } else {
            this.stopRecording();
        }
    }

    async startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.mediaRecorder = new MediaRecorder(stream);
            this.audioChunks = [];

            this.mediaRecorder.ondataavailable = (event) => {
                this.audioChunks.push(event.data);
            };

            this.mediaRecorder.onstop = () => {
                this.processRecording();
            };

            this.mediaRecorder.start();
            this.isRecording = true;
            this.updateRecordingUI();
            this.startLiveTranscription();
            this.startAudioVisualization(stream);
        } catch (error) {
            console.error('Error accessing microphone:', error);
            this.addMessage('system', 'Error: Could not access microphone. Please check permissions.');
        }
    }

    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
            this.isRecording = false;
            this.updateRecordingUI();
            this.stopLiveTranscription();
            this.stopAudioVisualization();
        }
    }

    updateRecordingUI() {
        if (this.isRecording) {
            this.recordBtn.classList.add('recording');
            this.recordBtn.querySelector('.btn-text').textContent = 'Stop Recording';
            this.recordingIndicator.classList.add('active');
        } else {
            this.recordBtn.classList.remove('recording');
            this.recordBtn.querySelector('.btn-text').textContent = 'Start Recording';
            this.recordingIndicator.classList.remove('active');
        }
    }

    startAudioVisualization(stream) {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        const microphone = audioContext.createMediaStreamSource(stream);
        microphone.connect(analyser);

        analyser.fftSize = 32;
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const bars = this.audioVisualizer.querySelectorAll('.bar');
        
        const animate = () => {
            if (!this.isRecording) return;
            
            analyser.getByteFrequencyData(dataArray);
            
            bars.forEach((bar, index) => {
                const value = dataArray[index] || 0;
                const height = (value / 255) * 40 + 5;
                bar.style.height = `${height}px`;
                bar.classList.add('active');
            });
            
            requestAnimationFrame(animate);
        };
        
        animate();
    }

    stopAudioVisualization() {
        const bars = this.audioVisualizer.querySelectorAll('.bar');
        bars.forEach(bar => {
            bar.classList.remove('active');
            bar.style.height = '5px';
        });
    }

    async retryWithBackoff(fn, retries = this.maxRetries, delay = this.baseRetryDelay) {
        try {
            return await fn();
        } catch (error) {
            if (retries <= 0) {
                throw error;
            }
            
            console.warn(`Operation failed, retrying in ${delay}ms... (${retries} retries left)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return this.retryWithBackoff(fn, retries - 1, delay * 2);
        }
    }

    async processRecording() {
        this.showLoading();
        
        try {
            // Step 1: Convert audio to text
            this.setLoadingStep(1);
            const audioBlob = new Blob(this.audioChunks, { type: 'audio/wav' });
            const transcription = await this.retryWithBackoff(
                () => this.transcribeAudio(audioBlob)
            );
            
            if (!transcription.trim()) {
                this.hideLoading();
                this.addMessage('system', 'No speech detected. Try speaking louder or closer to the microphone.');
                return;
            }

            this.addMessage('user', transcription);
            
            // Step 2: Generate AI response
            this.setLoadingStep(2);
            const aiResponse = await this.retryWithBackoff(
                () => this.generateSmackTalkResponse(transcription)
            );
            this.addMessage('ai', aiResponse);
            
            // Step 3: Generate voice clone and play
            this.setLoadingStep(3);
            await this.retryWithBackoff(
                () => this.speakResponse(aiResponse, audioBlob)
            );
            
            // Update conversation history and learning
            this.updateConversationHistory(transcription, aiResponse);
            this.updateSpeakingStyle(transcription);
            
        } catch (error) {
            console.error('Error processing recording:', error);
            let errorMessage = 'Error processing your recording. ';
            
            if (error.message.includes('Failed to fetch') || error.message.includes('network')) {
                errorMessage += 'Network connection issue. Please check your internet and try again.';
            } else if (error.message.includes('quota') || error.message.includes('limit')) {
                errorMessage += 'Service temporarily unavailable. Please try again in a moment.';
            } else {
                errorMessage += 'Please try again.';
            }
            
            this.addMessage('system', errorMessage);
        } finally {
            this.hideLoading();
        }
    }

    async transcribeAudio(audioBlob) {
        // Use the transcript from live recognition (final + last interim)
        const liveTranscript = (this.finalTranscript + this.lastInterimTranscript).trim();
        if (liveTranscript) {
            return liveTranscript;
        }
        
        // If no live transcript available, return error message
        throw new Error('No speech detected during recording');
    }

    async generateSmackTalkResponse(userInput) {
        try {
            const systemPrompt = `You are a sassy AI that roasts and talks smack back to the user in their own style. 
            Be playful, witty, and engaging - not mean or hurtful. Match their energy and speaking style.
            
            User's speaking style patterns: ${JSON.stringify(this.userSpeakingStyle)}
            
            Recent conversation context: ${this.conversationHistory.slice(-5).map(msg => `${msg.role}: ${msg.content}`).join('\n')}
            
            Respond with attitude and personality, keeping it fun and engaging. Use their own words and phrases against them when possible.`;

            const completion = await websim.chat.completions.create({
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userInput }
                ]
            });

            return completion.content;
        } catch (error) {
            if (error.message.includes('network') || error.message.includes('fetch')) {
                throw new Error('Network error generating response');
            }
            throw error;
        }
    }

    async speakResponse(text, userVoiceSample) {
        try {
            let voiceOptions = { text };
            
            if (this.voiceSample) {
                // Use the stored voice sample for consistency
                voiceOptions.voice_sample = this.voiceSample;
            } else if (userVoiceSample) {
                // Convert blob to data URL for voice cloning
                try {
                    const arrayBuffer = await userVoiceSample.arrayBuffer();
                    const uint8Array = new Uint8Array(arrayBuffer);
                    const base64 = btoa(String.fromCharCode.apply(null, uint8Array));
                    const dataUrl = `data:audio/wav;base64,${base64}`;
                    
                    voiceOptions.voice_sample = dataUrl;
                    this.voiceSample = dataUrl; // Store for future use
                } catch (voiceError) {
                    console.warn('Failed to process voice sample, using default voice:', voiceError);
                    voiceOptions.voice = 'en-male';
                }
            } else {
                // Fallback to default voice
                voiceOptions.voice = 'en-male';
            }

            const result = await websim.textToSpeech(voiceOptions);
            
            // Play the audio with error handling
            const audio = new Audio(result.url);
            
            return new Promise((resolve, reject) => {
                audio.onloadeddata = () => {
                    audio.play().then(resolve).catch(reject);
                };
                audio.onerror = () => {
                    reject(new Error('Failed to load audio'));
                };
                audio.onended = resolve;
            });
            
        } catch (error) {
            console.error('Error generating speech:', error);
            
            // Enhanced fallback handling
            try {
                console.log('Attempting fallback to default voice...');
                const result = await websim.textToSpeech({
                    text: text,
                    voice: 'en-male'
                });
                
                const audio = new Audio(result.url);
                return new Promise((resolve, reject) => {
                    audio.onloadeddata = () => {
                        audio.play().then(resolve).catch(reject);
                    };
                    audio.onerror = () => {
                        reject(new Error('Failed to load fallback audio'));
                    };
                    audio.onended = resolve;
                });
            } catch (fallbackError) {
                console.error('Fallback voice also failed:', fallbackError);
                throw new Error('Text-to-speech service unavailable');
            }
        }
    }

    addMessage(type, content) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}-message`;
        
        const header = document.createElement('div');
        header.className = 'message-header';
        header.textContent = type === 'user' ? 'You said:' : 
                           type === 'ai' ? 'Your AI Clone:' : 'System:';
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.textContent = content;
        
        messageDiv.appendChild(header);
        messageDiv.appendChild(contentDiv);
        
        // Remove welcome message if it exists
        const welcomeMessage = this.messageContainer.querySelector('.welcome-message');
        if (welcomeMessage) {
            welcomeMessage.remove();
        }
        
        this.messageContainer.appendChild(messageDiv);
        this.messageContainer.scrollTop = this.messageContainer.scrollHeight;
    }

    showLoading() {
        this.loadingOverlay.classList.add('active');
        this.setLoadingStep(0);
    }

    hideLoading() {
        this.loadingOverlay.classList.remove('active');
        document.querySelectorAll('.step').forEach(step => step.classList.remove('active'));
    }

    setLoadingStep(stepNumber) {
        document.querySelectorAll('.step').forEach(step => step.classList.remove('active'));
        
        const messages = [
            'Getting ready...',
            'Listening to your trash talk...',
            'Cooking up some fire comebacks...',
            'Making your voice clone roast you back...'
        ];
        
        this.loadingText.textContent = messages[stepNumber] || 'Processing...';
        
        if (stepNumber > 0) {
            const step = document.getElementById(`step${stepNumber}`);
            if (step) step.classList.add('active');
        }
    }

    updateConversationHistory(userMessage, aiMessage) {
        this.conversationHistory.push(
            { role: 'user', content: userMessage },
            { role: 'assistant', content: aiMessage }
        );
        
        // Keep only last 20 messages for performance
        if (this.conversationHistory.length > 20) {
            this.conversationHistory = this.conversationHistory.slice(-20);
        }
        
        this.saveConversationHistory();
        this.updateConversationCount();
    }

    updateSpeakingStyle(userInput) {
        // Analyze user's speaking patterns
        const words = userInput.toLowerCase().split(' ');
        const commonPhrases = this.extractPhrases(userInput);
        
        // Update speaking style profile
        words.forEach(word => {
            if (word.length > 3) { // Skip common short words
                this.userSpeakingStyle.commonWords[word] = 
                    (this.userSpeakingStyle.commonWords[word] || 0) + 1;
            }
        });
        
        commonPhrases.forEach(phrase => {
            this.userSpeakingStyle.phrases[phrase] = 
                (this.userSpeakingStyle.phrases[phrase] || 0) + 1;
        });
        
        this.saveSpeakingStyle();
    }

    extractPhrases(text) {
        // Simple phrase extraction (2-3 word combinations)
        const words = text.toLowerCase().split(' ');
        const phrases = [];
        
        for (let i = 0; i < words.length - 1; i++) {
            if (words[i].length > 2 && words[i + 1].length > 2) {
                phrases.push(`${words[i]} ${words[i + 1]}`);
            }
        }
        
        return phrases;
    }

    clearHistory() {
        this.conversationHistory = [];
        this.userSpeakingStyle = { commonWords: {}, phrases: {} };
        this.voiceSample = null;
        
        this.saveConversationHistory();
        this.saveSpeakingStyle();
        
        this.messageContainer.innerHTML = `
            <div class="welcome-message">
                <p> Ready to get roasted by yourself? Hit that mic and say something!</p>
            </div>
        `;
        
        this.updateConversationCount();
    }

    updateConversationCount() {
        const count = Math.floor(this.conversationHistory.length / 2);
        this.conversationCountEl.textContent = count;
    }

    loadConversationHistory() {
        const saved = localStorage.getItem('smackTalkHistory');
        return saved ? JSON.parse(saved) : [];
    }

    saveConversationHistory() {
        localStorage.setItem('smackTalkHistory', JSON.stringify(this.conversationHistory));
    }

    loadSpeakingStyle() {
        const saved = localStorage.getItem('smackTalkStyle');
        return saved ? JSON.parse(saved) : { commonWords: {}, phrases: {} };
    }

    saveSpeakingStyle() {
        localStorage.setItem('smackTalkStyle', JSON.stringify(this.userSpeakingStyle));
    }

    startLiveTranscription() {
        if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
            console.warn('Speech recognition not supported');
            return;
        }

        this.liveRecognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
        this.liveRecognition.continuous = true;
        this.liveRecognition.interimResults = true;
        this.liveRecognition.lang = 'en-US';
        
        this.finalTranscript = '';
        this.lastInterimTranscript = '';
        this.liveTranscription.classList.add('active');
        this.transcriptionText.textContent = 'Listening...';

        this.liveRecognition.onresult = (event) => {
            let interimTranscript = '';
            
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    this.finalTranscript += transcript + ' ';
                } else {
                    interimTranscript += transcript;
                }
            }
            
            // Store the latest interim transcript
            this.lastInterimTranscript = interimTranscript;
            
            const displayText = this.finalTranscript + interimTranscript;
            this.transcriptionText.textContent = displayText || 'Listening...';
            this.transcriptionText.className = interimTranscript ? 'transcription-text interim' : 'transcription-text';
        };

        this.liveRecognition.onerror = (event) => {
            console.warn('Live transcription error:', event.error);
            if (event.error !== 'no-speech') {
                this.transcriptionText.textContent = 'Transcription error - keep speaking...';
            }
        };

        this.liveRecognition.onend = () => {
            if (this.isRecording) {
                // Restart if still recording
                setTimeout(() => {
                    if (this.isRecording && this.liveRecognition) {
                        this.liveRecognition.start();
                    }
                }, 100);
            }
        };

        this.liveRecognition.start();
    }

    stopLiveTranscription() {
        if (this.liveRecognition) {
            this.liveRecognition.stop();
            this.liveRecognition = null;
        }
        this.liveTranscription.classList.remove('active');
    }
}

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new SmackTalkApp();
});