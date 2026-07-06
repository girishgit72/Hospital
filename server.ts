/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  loadPatients,
  savePatients,
  loadAppointments,
  saveAppointments,
  getDbDiagnostics
} from './server/binaryDb';
import { Patient, Appointment, Doctor } from './src/types';

const PORT = 3000;

// Hardcoded doctor registry
const DOCTORS: Doctor[] = [
  {
    name: 'Dr. Gregory House',
    specialty: 'Diagnostic Medicine',
    room: 'Room 101',
    availability: { days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'], hours: '09:00 - 16:00' }
  },
  {
    name: 'Dr. Meredith Grey',
    specialty: 'General Surgery',
    room: 'Room 204',
    availability: { days: ['Monday', 'Wednesday', 'Friday'], hours: '08:00 - 15:00' }
  },
  {
    name: 'Dr. Stephen Strange',
    specialty: 'Neurology',
    room: 'Room 302',
    availability: { days: ['Tuesday', 'Thursday', 'Friday'], hours: '10:00 - 17:00' }
  },
  {
    name: 'Dr. Miranda Bailey',
    specialty: 'Pediatrics',
    room: 'Room 105',
    availability: { days: ['Monday', 'Tuesday', 'Thursday', 'Friday'], hours: '09:00 - 17:00' }
  },
  {
    name: 'Dr. John Watson',
    specialty: 'General Practice',
    room: 'Room 102',
    availability: { days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], hours: '08:30 - 16:30' }
  },
  {
    name: 'Dr. Leonard McCoy',
    specialty: 'Cardiology',
    room: 'Room 201',
    availability: { days: ['Wednesday', 'Thursday', 'Friday'], hours: '09:00 - 15:00' }
  }
];

// Helper to convert HH:MM to minutes-from-midnight
function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(':');
  if (parts.length !== 2) return 0;
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(minutes)) return 0;
  return hours * 60 + minutes;
}

// Helper to check if two appointment intervals overlap
function isOverlapping(
  time1: string,
  dur1: number,
  time2: string,
  dur2: number
): boolean {
  const start1 = timeToMinutes(time1);
  const end1 = start1 + dur1;
  const start2 = timeToMinutes(time2);
  const end2 = start2 + dur2;

  // Overlap if start1 < end2 and start2 < end1
  return start1 < end2 && start2 < end1;
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // --- API ROUTES ---

  // Get doctors registry
  app.get('/api/doctors', (_req: Request, res: Response) => {
    res.json(DOCTORS);
  });

  // 1. PATIENTS API
  app.get('/api/patients', async (_req: Request, res: Response) => {
    try {
      const patients = await loadPatients();
      res.json(patients);
    } catch (err) {
      res.status(500).json({ error: 'Failed to load patients' });
    }
  });

  app.post('/api/patients', async (req: Request, res: Response) => {
    try {
      const patients = await loadPatients();
      const patientData: Omit<Patient, 'id' | 'dateRegistered'> = req.body;

      if (!patientData.name || !patientData.dob || !patientData.contact) {
        res.status(400).json({ error: 'Name, DOB, and contact fields are required' });
        return;
      }

      // Generate Patient ID: PAT-YYYY-XXXX
      const year = new Date().getFullYear();
      let maxNum = 0;
      for (const p of patients) {
        const match = p.id.match(/PAT-\d+-(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      }
      const nextNum = (maxNum + 1).toString().padStart(4, '0');
      const newId = `PAT-${year}-${nextNum}`;

      const newPatient: Patient = {
        ...patientData,
        id: newId,
        dateRegistered: new Date().toISOString().split('T')[0]
      };

      patients.push(newPatient);
      await savePatients(patients);

      res.status(201).json(newPatient);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create patient record' });
    }
  });

  app.put('/api/patients/:id', async (req: Request, res: Response) => {
    try {
      const patients = await loadPatients();
      const id = req.params.id;
      const index = patients.findIndex(p => p.id === id);

      if (index === -1) {
        res.status(404).json({ error: 'Patient not found' });
        return;
      }

      const updatedPatient: Patient = {
        ...patients[index],
        ...req.body,
        id // lock ID from mutation
      };

      patients[index] = updatedPatient;
      await savePatients(patients);

      // Side-effect: If patient name changed, update it in scheduled appointments too!
      const appointments = await loadAppointments();
      let apptsChanged = false;
      for (const appt of appointments) {
        if (appt.patientId === id && appt.patientName !== updatedPatient.name) {
          appt.patientName = updatedPatient.name;
          apptsChanged = true;
        }
      }
      if (apptsChanged) {
        await saveAppointments(appointments);
      }

      res.json(updatedPatient);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update patient record' });
    }
  });

  app.delete('/api/patients/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const patients = await loadPatients();
      const filteredPatients = patients.filter(p => p.id !== id);

      if (patients.length === filteredPatients.length) {
        res.status(404).json({ error: 'Patient not found' });
        return;
      }

      await savePatients(filteredPatients);

      // Side-effect: Cancel/delete appointments for this patient
      const appointments = await loadAppointments();
      const filteredAppointments = appointments.filter(appt => appt.patientId !== id);
      await saveAppointments(filteredAppointments);

      res.json({ success: true, message: `Patient ${id} and their appointments deleted successfully` });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete patient record' });
    }
  });


  // 2. APPOINTMENTS API
  app.get('/api/appointments', async (_req: Request, res: Response) => {
    try {
      const appointments = await loadAppointments();
      res.json(appointments);
    } catch (err) {
      res.status(500).json({ error: 'Failed to load appointments' });
    }
  });

  app.post('/api/appointments', async (req: Request, res: Response) => {
    try {
      const appointments = await loadAppointments();
      const apptData: Omit<Appointment, 'id'> = req.body;

      if (!apptData.patientId || !apptData.doctorName || !apptData.date || !apptData.time || !apptData.duration) {
        res.status(400).json({ error: 'Missing required appointment parameters' });
        return;
      }

      // 🛑 Conflict Detection Algorithm:
      // Find any overlapping active appointment for the SAME doctor on the SAME date.
      const conflict = appointments.find(appt => {
        return (
          appt.status !== 'Cancelled' &&
          appt.doctorName.toLowerCase() === apptData.doctorName.toLowerCase() &&
          appt.date === apptData.date &&
          isOverlapping(appt.time, appt.duration, apptData.time, apptData.duration)
        );
      });

      if (conflict) {
        res.status(409).json({
          error: 'Scheduling Conflict',
          message: `${apptData.doctorName} has an overlapping appointment scheduled on ${apptData.date} at ${conflict.time} (${conflict.duration} mins) for patient ${conflict.patientName}.`
        });
        return;
      }

      // Generate unique appointment ID: APT-YYYY-XXXX
      const year = new Date().getFullYear();
      let maxNum = 0;
      for (const a of appointments) {
        const match = a.id.match(/APT-\d+-(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      }
      const nextNum = (maxNum + 1).toString().padStart(4, '0');
      const newId = `APT-${year}-${nextNum}`;

      const newAppt: Appointment = {
        ...apptData,
        id: newId
      };

      appointments.push(newAppt);
      await saveAppointments(appointments);

      res.status(201).json(newAppt);
    } catch (err) {
      res.status(500).json({ error: 'Failed to schedule appointment' });
    }
  });

  app.put('/api/appointments/:id', async (req: Request, res: Response) => {
    try {
      const appointments = await loadAppointments();
      const id = req.params.id;
      const index = appointments.findIndex(a => a.id === id);

      if (index === -1) {
        res.status(404).json({ error: 'Appointment not found' });
        return;
      }

      const existingAppt = appointments[index];
      const proposedAppt: Appointment = {
        ...existingAppt,
        ...req.body,
        id // lock ID
      };

      // 🛑 Conflict Detection for updates (excluding the current appointment):
      if (proposedAppt.status !== 'Cancelled') {
        const conflict = appointments.find(appt => {
          return (
            appt.id !== id && // Exclude self
            appt.status !== 'Cancelled' &&
            appt.doctorName.toLowerCase() === proposedAppt.doctorName.toLowerCase() &&
            appt.date === proposedAppt.date &&
            isOverlapping(appt.time, appt.duration, proposedAppt.time, proposedAppt.duration)
          );
        });

        if (conflict) {
          res.status(409).json({
            error: 'Scheduling Conflict',
            message: `${proposedAppt.doctorName} already has an overlapping appointment on ${proposedAppt.date} at ${conflict.time} (${conflict.duration} mins) for patient ${conflict.patientName}.`
          });
          return;
        }
      }

      appointments[index] = proposedAppt;
      await saveAppointments(appointments);

      res.json(proposedAppt);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update appointment' });
    }
  });

  app.delete('/api/appointments/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const appointments = await loadAppointments();
      const filtered = appointments.filter(a => a.id !== id);

      if (appointments.length === filtered.length) {
        res.status(404).json({ error: 'Appointment not found' });
        return;
      }

      await saveAppointments(filtered);
      res.json({ success: true, message: `Appointment ${id} deleted successfully` });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete appointment' });
    }
  });

  // 3. STORAGE DIAGNOSTICS API
  app.get('/api/diagnostics', async (_req: Request, res: Response) => {
    try {
      const diagnostics = await getDbDiagnostics();
      res.json(diagnostics);
    } catch (err) {
      res.status(500).json({ error: 'Failed to retrieve storage diagnostics' });
    }
  });


  // --- VITE AND STATIC ASSETS INTEGRATION ---

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Hospital Management Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Critical Server Boot Failure:', err);
});
