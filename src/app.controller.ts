import { Controller, Get } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Controller()
export class AppController {
  
  @Get('videos')
  getVideos() {
    const recordingsDir = path.join(__dirname, '..', 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      return [];
    }
    
    const dates = fs.readdirSync(recordingsDir);
    const result: any[] = [];

    for (const date of dates) {
      const datePath = path.join(recordingsDir, date);
      if (fs.statSync(datePath).isDirectory()) {
        const files = fs.readdirSync(datePath).filter(f => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv'));
        if (files.length > 0) {
          result.push({
            date,
            files: files.map(f => ({
              name: f,
              url: `/recordings/${date}/${f}`
            }))
          });
        }
      }
    }

    // Sort by date descending
    result.sort((a, b) => b.date.localeCompare(a.date));
    return result;
  }
}
