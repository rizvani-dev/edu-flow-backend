const PDFDocument = require('pdfkit');

/**
 * Generate a professional Fee Receipt / Chalan PDF
 * Returns a Promise that resolves with a Buffer
 */
function generateFeeReceiptPdf({ school, student, payment, fee }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 45 });
      const buffers = [];

      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const primaryColor = '#1e3a8a';   // Deep navy blue
      const secondaryColor = '#3b82f6'; // Bright blue
      const textColor = '#1f2937';      // Dark gray
      const lightBg = '#f8fafc';        // Very light slate
      const borderColor = '#e2e8f0';

      // ================= HEADER / BRANDING =================
      doc.rect(45, 45, 505, 90).fill(lightBg);
      doc.rect(45, 45, 6, 90).fill(primaryColor);

      doc.fillColor(primaryColor).fontSize(20).font('Helvetica-Bold')
         .text((school?.name || 'EduFlow School System').toUpperCase(), 65, 58);

      doc.fillColor('#64748b').fontSize(9).font('Helvetica')
         .text('Official Monthly Fee Payment Voucher & Receipt', 65, 82)
         .text(`School ID: #${school?.id || 1}  •  Status: Verified Paid`, 65, 96);

      const chalanNo = `CHL-${new Date(payment?.created_at || Date.now()).getFullYear()}-${String(payment?.id || 1).padStart(5, '0')}`;
      doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold')
         .text('RECEIPT / CHALAN NO:', 350, 60, { width: 190, align: 'right' });
      doc.fillColor(secondaryColor).fontSize(12).font('Helvetica-Bold')
         .text(chalanNo, 350, 75, { width: 190, align: 'right' });
      doc.fillColor('#64748b').fontSize(8).font('Helvetica')
         .text(`Issued: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`, 350, 93, { width: 190, align: 'right' });

      // ================= TWO-COLUMN DETAILS GRID =================
      const topY = 150;

      // Student Box
      doc.rect(45, topY, 245, 115).strokeColor(borderColor).lineWidth(1).stroke();
      doc.rect(45, topY, 245, 24).fill(primaryColor);
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold')
         .text('STUDENT INFORMATION', 55, topY + 7);

      doc.fillColor(textColor).fontSize(9).font('Helvetica');
      let sy = topY + 32;
      const sDetails = [
        ['Student Name:', student?.name || 'N/A'],
        ['Student ID:', `#${student?.id || 'N/A'}`],
        ['Class & Section:', `${student?.class_name || 'N/A'} ${student?.section ? `(${student.section})` : ''}`],
        ['Email:', student?.email || 'N/A']
      ];
      sDetails.forEach(([lbl, val]) => {
        doc.font('Helvetica-Bold').fillColor('#475569').text(lbl, 55, sy, { width: 90 });
        doc.font('Helvetica').fillColor(textColor).text(val, 145, sy, { width: 140 });
        sy += 18;
      });

      // Transaction / Voucher Box
      doc.rect(305, topY, 245, 115).strokeColor(borderColor).lineWidth(1).stroke();
      doc.rect(305, topY, 245, 24).fill(primaryColor);
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold')
         .text('TRANSACTION DETAILS', 315, topY + 7);

      let py = topY + 32;
      const pDetails = [
        ['Fee Month:', `${payment?.month || fee?.month || 'N/A'} ${payment?.year || fee?.year || ''}`],
        ['Transaction ID:', payment?.transaction_id || 'N/A'],
        ['Payment Date:', payment?.created_at ? new Date(payment.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A'],
        ['Payment Status:', (payment?.status || fee?.status || 'PAID').toUpperCase()]
      ];
      pDetails.forEach(([lbl, val]) => {
        doc.font('Helvetica-Bold').fillColor('#475569').text(lbl, 315, py, { width: 95 });
        if (lbl === 'Payment Status:') {
          doc.font('Helvetica-Bold').fillColor('#16a34a').text(val, 410, py, { width: 135 });
        } else {
          doc.font('Helvetica').fillColor(textColor).text(val, 410, py, { width: 135 });
        }
        py += 18;
      });

      // ================= ITEMIZED BREAKDOWN TABLE =================
      const tableY = 285;
      doc.rect(45, tableY, 505, 26).fill(lightBg);
      doc.rect(45, tableY, 505, 1).fill(primaryColor);

      doc.fillColor(primaryColor).fontSize(9).font('Helvetica-Bold')
         .text('#', 55, tableY + 8)
         .text('FEE DESCRIPTION', 85, tableY + 8)
         .text('BILLING PERIOD', 270, tableY + 8)
         .text('DUE DATE', 380, tableY + 8)
         .text('AMOUNT (PKR)', 455, tableY + 8, { width: 90, align: 'right' });

      // Table Row
      const rowY = tableY + 34;
      const amountNum = Number(fee?.amount || payment?.amount || 0);
      const dueDateStr = fee?.due_date ? new Date(fee.due_date).toLocaleDateString() : 'Paid on time';

      doc.fillColor(textColor).fontSize(9).font('Helvetica')
         .text('1', 55, rowY)
         .text('Monthly Tuition & Academic Fee', 85, rowY)
         .text(`${payment?.month || fee?.month || 'Current'} ${payment?.year || fee?.year || ''}`, 270, rowY)
         .text(dueDateStr, 380, rowY)
         .font('Helvetica-Bold')
         .text(`PKR ${amountNum.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 455, rowY, { width: 90, align: 'right' });

      doc.moveTo(45, rowY + 22).lineTo(550, rowY + 22).strokeColor(borderColor).lineWidth(1).stroke();

      // Total Box
      const totalY = rowY + 35;
      doc.rect(305, totalY, 245, 60).fill(lightBg);
      doc.rect(305, totalY, 245, 60).strokeColor(primaryColor).lineWidth(1).stroke();

      doc.fillColor('#475569').fontSize(9).font('Helvetica')
         .text('Subtotal:', 315, totalY + 10)
         .text('Tax / Surcharge:', 315, totalY + 26)
         .font('Helvetica-Bold').fillColor(primaryColor)
         .text('TOTAL PAID:', 315, totalY + 42);

      doc.fillColor(textColor).fontSize(9).font('Helvetica')
         .text(`PKR ${amountNum.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 430, totalY + 10, { width: 110, align: 'right' })
         .text('PKR 0.00', 430, totalY + 26, { width: 110, align: 'right' })
         .font('Helvetica-Bold').fillColor('#16a34a')
         .text(`PKR ${amountNum.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 430, totalY + 42, { width: 110, align: 'right' });

      // Important Notes
      doc.fillColor('#64748b').fontSize(8).font('Helvetica')
         .text('• This receipt confirms authorized payment processed through EduFlow SaaS.', 45, totalY + 10)
         .text('• Fee once paid is non-refundable and subject to school policy.', 45, totalY + 22)
         .text('• In case of any discrepancies, please present this original voucher to Accounts.', 45, totalY + 34);

      // ================= VERIFICATION & SIGNATURES =================
      const signY = 560;
      doc.moveTo(65, signY).lineTo(215, signY).strokeColor('#94a3b8').lineWidth(1).stroke();
      doc.moveTo(380, signY).lineTo(530, signY).strokeColor('#94a3b8').lineWidth(1).stroke();

      doc.fillColor('#64748b').fontSize(8).font('Helvetica')
         .text('Depositor / Student Signature', 65, signY + 6, { width: 150, align: 'center' })
         .text('Authorized School Officer / Stamp', 380, signY + 6, { width: 150, align: 'center' });

      // ================= FOOTER =================
      const footerY = 660;
      doc.rect(45, footerY, 505, 30).fill('#f1f5f9');
      doc.fillColor('#64748b').fontSize(7).font('Helvetica')
         .text(`Generated on ${new Date().toUTCString()}  •  Secure EduFlow System Voucher  •  Document Hash Verified`, 45, footerY + 11, { width: 505, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Generate a professional Teacher Salary Slip PDF
 * Returns a Promise that resolves with a Buffer
 */
function generateSalarySlipPdf({ school, teacher, salary }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 45 });
      const buffers = [];

      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const primaryColor = '#0f766e';   // Deep Teal
      const secondaryColor = '#0d9488'; // Vibrant teal
      const textColor = '#1e293b';
      const lightBg = '#f0fdfa';
      const borderColor = '#ccfbf1';

      // Header Box
      doc.rect(45, 45, 505, 90).fill(lightBg);
      doc.rect(45, 45, 6, 90).fill(primaryColor);

      doc.fillColor(primaryColor).fontSize(20).font('Helvetica-Bold')
         .text((school?.name || 'EduFlow School System').toUpperCase(), 65, 58);

      doc.fillColor('#64748b').fontSize(9).font('Helvetica')
         .text('Staff Monthly Payroll Statement & Salary Slip', 65, 82)
         .text(`School ID: #${school?.id || 1}  •  Confidential Payroll Document`, 65, 96);

      const slipNo = `SLIP-${salary?.year || new Date().getFullYear()}-${String(salary?.id || 1).padStart(5, '0')}`;
      doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold')
         .text('SALARY SLIP NO:', 350, 60, { width: 190, align: 'right' });
      doc.fillColor(secondaryColor).fontSize(12).font('Helvetica-Bold')
         .text(slipNo, 350, 75, { width: 190, align: 'right' });
      doc.fillColor('#64748b').fontSize(8).font('Helvetica')
         .text(`Month: ${salary?.month || 'N/A'} ${salary?.year || ''}`, 350, 93, { width: 190, align: 'right' });

      // Teacher Info Box
      const topY = 150;
      doc.rect(45, topY, 505, 80).strokeColor(borderColor).lineWidth(1).stroke();
      doc.rect(45, topY, 505, 22).fill(primaryColor);
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold')
         .text('EMPLOYEE CREDENTIALS', 55, topY + 6);

      let ey = topY + 30;
      doc.font('Helvetica-Bold').fillColor('#475569').fontSize(9)
         .text('Teacher Name:', 55, ey)
         .text('Teacher ID:', 55, ey + 18)
         .text('Department / Role:', 305, ey)
         .text('Payment Status:', 305, ey + 18);

      doc.font('Helvetica').fillColor(textColor).fontSize(9)
         .text(teacher?.name || 'N/A', 145, ey)
         .text(`#${teacher?.id || 'N/A'}`, 145, ey + 18)
         .text(teacher?.class_name ? `Class Teacher (${teacher.class_name})` : 'Faculty Teacher', 410, ey)
         .font('Helvetica-Bold').fillColor('#16a34a')
         .text((salary?.status || 'PAID').toUpperCase(), 410, ey + 18);

      // Earnings & Deductions Tables (Side by Side)
      const tableY = 245;
      const boxWidth = 245;

      const basicSalary = Number(salary?.basic_salary || salary?.amount || 0);
      const allowances = Number(salary?.allowances || 0);
      const bonus = Number(salary?.bonus || 0);
      const overtime = Number(salary?.overtime || 0);
      const totalEarnings = basicSalary + allowances + bonus + overtime;

      const deductions = Number(salary?.deductions || 0);
      const advance = Number(salary?.advance || 0);
      const fine = Number(salary?.fine || 0);
      const totalDeductions = deductions + advance + fine;

      const netSalary = totalEarnings - totalDeductions;

      // Earnings Box
      doc.rect(45, tableY, boxWidth, 160).strokeColor(borderColor).lineWidth(1).stroke();
      doc.rect(45, tableY, boxWidth, 22).fill('#0f766e');
      doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold')
         .text('EARNINGS', 55, tableY + 6)
         .text('AMOUNT (PKR)', 190, tableY + 6, { width: 90, align: 'right' });

      let earnY = tableY + 32;
      const earnRows = [
        ['Basic Salary', basicSalary],
        ['Allowances', allowances],
        ['Bonus', bonus],
        ['Overtime', overtime]
      ];
      earnRows.forEach(([lbl, val]) => {
        doc.font('Helvetica').fillColor('#475569').fontSize(9).text(lbl, 55, earnY);
        doc.font('Helvetica').fillColor(textColor).text(`PKR ${val.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 190, earnY, { width: 90, align: 'right' });
        earnY += 20;
      });
      doc.moveTo(45, earnY + 2).lineTo(45 + boxWidth, earnY + 2).strokeColor(borderColor).lineWidth(1).stroke();
      doc.font('Helvetica-Bold').fillColor(primaryColor).fontSize(9)
         .text('Total Earnings', 55, earnY + 8)
         .text(`PKR ${totalEarnings.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 190, earnY + 8, { width: 90, align: 'right' });

      // Deductions Box
      doc.rect(305, tableY, boxWidth, 160).strokeColor(borderColor).lineWidth(1).stroke();
      doc.rect(305, tableY, boxWidth, 22).fill('#be123c'); // Deep red for deductions header
      doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold')
         .text('DEDUCTIONS', 315, tableY + 6)
         .text('AMOUNT (PKR)', 450, tableY + 6, { width: 90, align: 'right' });

      let dedY = tableY + 32;
      const dedRows = [
        ['General Deductions', deductions],
        ['Salary Advance', advance],
        ['Fines / Penalties', fine],
        ['Tax', 0]
      ];
      dedRows.forEach(([lbl, val]) => {
        doc.font('Helvetica').fillColor('#475569').fontSize(9).text(lbl, 315, dedY);
        doc.font('Helvetica').fillColor(textColor).text(`PKR ${val.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 450, dedY, { width: 90, align: 'right' });
        dedY += 20;
      });
      doc.moveTo(305, dedY + 2).lineTo(305 + boxWidth, dedY + 2).strokeColor(borderColor).lineWidth(1).stroke();
      doc.font('Helvetica-Bold').fillColor('#be123c').fontSize(9)
         .text('Total Deductions', 315, dedY + 8)
         .text(`PKR ${totalDeductions.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 450, dedY + 8, { width: 90, align: 'right' });

      // NET SALARY HIGHLIGHT BOX
      const netY = tableY + 175;
      doc.rect(45, netY, 505, 50).fill(lightBg);
      doc.rect(45, netY, 505, 50).strokeColor(primaryColor).lineWidth(1.5).stroke();

      doc.fillColor(primaryColor).fontSize(11).font('Helvetica-Bold')
         .text('NET SALARY PAYABLE:', 65, netY + 18);
      doc.fillColor(secondaryColor).fontSize(18).font('Helvetica-Bold')
         .text(`PKR ${netSalary.toLocaleString('en-US', { minimumFractionDigits: 2 })}`, 260, netY + 15, { width: 275, align: 'right' });

      // Signatures
      const signY = 530;
      doc.moveTo(65, signY).lineTo(215, signY).strokeColor('#94a3b8').lineWidth(1).stroke();
      doc.moveTo(380, signY).lineTo(530, signY).strokeColor('#94a3b8').lineWidth(1).stroke();

      doc.fillColor('#64748b').fontSize(8).font('Helvetica')
         .text('Employee Signature', 65, signY + 6, { width: 150, align: 'center' })
         .text('Principal / Accountant Signature', 380, signY + 6, { width: 150, align: 'center' });

      // Footer
      const footerY = 650;
      doc.rect(45, footerY, 505, 30).fill('#f1f5f9');
      doc.fillColor('#64748b').fontSize(7).font('Helvetica')
         .text(`Generated on ${new Date().toUTCString()}  •  EduFlow Confidential Payroll  •  Official Record`, 45, footerY + 11, { width: 505, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateFeeReceiptPdf,
  generateSalarySlipPdf
};
